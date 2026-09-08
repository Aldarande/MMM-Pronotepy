#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# MMM-Pronotepy — module MagicMirror² pour Pronote
# Copyright (C) 2024-2026 Aldarande
# Licensed under the MIT License. See LICENSE for details.
"""
=====================================================================
MMM-Pronotepy — pronote_bridge.py
Pont Node <-> pronotepy.

Protocole : une commande JSON sur stdin, une réponse JSON sur stdout.
Toutes les traces partent sur stderr (reprises dans les logs du module).

Commandes :
  {"action": "setup_qr", "qr": {...}, "pin": "1234", "childName": "..."}
  {"action": "fetch",    "childName": "...", "config": {...}}

Réponses :
  {"ok": true,  "data": {...}}
  {"ok": false, "error": "...", "kind": "..."}

Les « kind » d'erreur, repris de la taxonomie éprouvée du plugin ProJote :
  no_tokens    aucun jeton enregistré
  bad_pin      le PIN ne déchiffre pas le contenu du QR Code
  qr_expired   PIN correct, mais Pronote refuse le jeton (QR > 10 min ou déjà utilisé)
  bad_qr       contenu du QR Code illisible (mal décodé, non hexadécimal)
  outdated     page de connexion non reconnue → pronotepy trop ancien
  auth_failed  jeton de reconnexion refusé
  network      incident réseau ou serveur momentanément indisponible
  error        autre

Plusieurs choix de conception viennent de mesures faites sur une instance
PRONOTE 2026.2.5 dans le cadre du plugin ProJote (même auteur) ; ils sont
signalés au fil du fichier.
=====================================================================
"""

import datetime as dt
import json
import os
import random
import re
import sys
import traceback

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(BASE_DIR, "cache")
# Fichier de l'époque « un seul compte ». Conservé en lecture seule : voir
# load_tokens(). Node le renomme en tokens-default.json au démarrage.
LEGACY_TOKEN_FILE = os.path.join(CACHE_DIR, "tokens.json")

# Réaffecté par set_account() au tout début de main().
TOKEN_FILE = os.path.join(CACHE_DIR, "tokens-default.json")

# L'UUID d'appareil reste commun aux comptes : c'est l'identité de CE miroir
# auprès de PRONOTE, pas celle d'un compte. Un téléphone portant deux comptes
# n'en a pas deux non plus.
UUID_FILE = os.path.join(CACHE_DIR, "device_uuid.txt")


def log(*args):
    """Trace vers stderr — Node la reprend dans son buffer de logs."""
    print(" ".join(str(a) for a in args), file=sys.stderr, flush=True)


# Node masque les traces du pont quand « debug » n'est pas activé sur
# l'instance. Ce préfixe désigne les messages qui doivent passer malgré
# tout : ceux qui annoncent une panne à venir. node_helper les reconnaît
# et les remonte en avertissement.
WARN_PREFIX = "WARN::"


def warn(*args):
    """Trace toujours visible, même sans « debug: true »."""
    log(WARN_PREFIX, *args)


try:
    sys.path.insert(0, BASE_DIR)
    import pronotepy
    from pronotepy import Client, ParentClient
    from pronotepy.exceptions import (
        PronoteAPIError,
        CryptoError,
        QRCodeDecryptError,
        ChildNotFound,
        ExpiredObject,
    )
    import pronote_compat

    # Indispensable : depuis le 2 septembre 2026, les instances PRONOTE >= 2026.2.5
    # ne chiffrent plus le challenge d'authentification, ce qui fait échouer TOUS
    # les modes de connexion de pronotepy 2.15.x. Voir pronote_compat.py.
    pronote_compat.apply()
except ImportError as exc:  # pragma: no cover
    print(json.dumps({
        "ok": False,
        "kind": "error",
        "error": (
            "pronotepy n'est pas installé ({}). Lancez `npm install` dans le "
            "dossier du module, ou `npm run setup`."
        ).format(exc),
    }))
    sys.exit(0)


# =====================================================================
# Stockage : UUID appareil + jetons
# =====================================================================

def _atomic_write(path, content, private=False):
    """Écriture atomique : .tmp + fsync + rename.

    Sans le fsync, le renommage peut devenir visible avant que les données ne
    soient réellement sur le disque : une coupure de courant laisserait un
    fichier vide, et le compte serait perdu.
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(content)
        fh.flush()
        os.fsync(fh.fileno())
    if private:
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass  # systèmes de fichiers sans permissions POSIX
    os.replace(tmp, path)


def get_device_uuid():
    """UUID d'appareil persistant. Pronote invalide le jeton s'il change."""
    os.makedirs(CACHE_DIR, exist_ok=True)
    if os.path.exists(UUID_FILE):
        with open(UUID_FILE, "r", encoding="utf-8") as fh:
            existing = fh.read().strip()
            if existing:
                return existing
    generated = "mmm-pronotepy-{:016x}".format(random.getrandbits(64))
    _atomic_write(UUID_FILE, generated)
    return generated


# ── Comptes multiples ────────────────────────────────────────────────
#
# Un compte parent ne couvre pas toujours toute la fratrie : un enfant peut
# dépendre d'un autre établissement, ou avoir son propre compte élève. Ce sont
# des JETONS distincts, chacun dans son fichier.
#
# L'étiquette de compte est normalisée par Node (lib/accounts.js) et arrive
# ici déjà réduite à [a-z0-9-]. On ne la re-normalise PAS — deux
# implémentations d'une même règle de nommage divergeraient, et la divergence
# ne se verrait que le jour où un jeton serait cherché au mauvais endroit. On
# se contente de valider : ce qui entre dans un chemin de fichier ne se prend
# jamais sur parole, fût-elle celle de notre propre code.
#
# Le pont traite UNE action pour UN compte par invocation : un état de module
# est donc suffisant, et sans risque de réentrance.

ACCOUNT_DEFAULT = "default"
_ACCOUNT_RE = re.compile(r"^[a-z0-9-]{1,48}$")


def _account_file(account):
    return os.path.join(CACHE_DIR, "tokens-{}.json".format(account))


def set_account(account):
    """Désigne le compte sur lequel porte cette invocation."""
    global TOKEN_FILE
    demande = account if isinstance(account, str) else ""
    if not _ACCOUNT_RE.match(demande):
        if demande:
            warn("Nom de compte refusé ({!r}) — repli sur « {} ».".format(
                demande, ACCOUNT_DEFAULT))
        demande = ACCOUNT_DEFAULT
    TOKEN_FILE = _account_file(demande)
    return demande


def load_tokens():
    # LEGACY_FILE : les installations antérieures aux comptes multiples ont un
    # « tokens.json » sans suffixe. Node le renomme au démarrage, mais le pont
    # peut être lancé à la main — mieux vaut le trouver que réclamer un rescan.
    candidats = [TOKEN_FILE, TOKEN_FILE + ".tmp"]
    if TOKEN_FILE == _account_file(ACCOUNT_DEFAULT):
        candidats += [LEGACY_TOKEN_FILE, LEGACY_TOKEN_FILE + ".tmp"]

    for candidate in candidats:
        try:
            if os.path.exists(candidate):
                with open(candidate, "r", encoding="utf-8") as fh:
                    return json.load(fh)
        except (ValueError, OSError) as exc:
            log("Lecture jetons ({}) :".format(candidate), exc)
    return None


def save_tokens(tokens):
    _atomic_write(TOKEN_FILE, json.dumps(tokens, indent=2, ensure_ascii=False),
                  private=True)


# ── Sauvegarde du jeton à CHAQUE authentification ────────────────────
#
# PRONOTE renouvelle le jeton de reconnexion à chaque authentification et
# n'accepte que le dernier émis — conserver un historique ne sert donc à rien.
# Or pronotepy se ré-authentifie à la moindre requête refusée : un cycle de
# collecte peut en compter plusieurs dizaines. Entre la première connexion et
# la fin du cycle, un arrêt du démon ou une coupure réseau perdrait le compte,
# et il faudrait rescanner un QR Code.
#
# Le seul filet possible est donc de ne jamais perdre le dernier jeton émis :
# on l'écrit sur disque dès qu'une authentification réussit, sans attendre la
# fin de la collecte. (Mécanisme et diagnostic repris de ProJote,
# resources/ProJoted/token_secours.py.)

_persist_hook_installed = False


def install_token_persistence():
    """Persiste les identifiants de reconnexion après chaque `_login` réussi."""
    global _persist_hook_installed
    if _persist_hook_installed:
        return

    from pronotepy import clients

    original_login = clients.ClientBase._login

    def _login_and_persist(self):
        connected = original_login(self)
        # Seuls les modes sans mot de passe reposent sur un jeton tournant.
        if not connected or getattr(self, "login_mode", None) not in ("token", "qr_code"):
            return connected
        try:
            store = load_tokens() or {}
            creds = self.export_credentials()
            # « or {} » et non un défaut de get() : après une promotion du
            # secours, la clé « backup » EXISTE avec la valeur None, et
            # dict.get(clé, défaut) rend alors None — pas le défaut. Le
            # .get() suivant levait un AttributeError, avalé par l'except
            # ci-dessous : plus aucun jeton n'était persisté, et le compte
            # mourait au cycle suivant puisque PRONOTE ne retient que le
            # dernier jeton émis. (Constaté en production le 2026-09-08.)
            backup = store.get("backup") or {}
            slot = "backup" if backup.get("uuid") == creds.get("uuid") else "primary"

            # Rien de neuf : ne pas réécrire. Un cycle de collecte peut
            # compter plusieurs dizaines d'authentifications, et chaque
            # écriture est fsync'ée — sur la carte SD d'un Raspberry Pi,
            # ces réécritures identiques sont de l'usure pure. PRONOTE
            # renouvelle le jeton à chaque authentification, donc le cas
            # est rare ; c'est un garde-fou, pas une optimisation.
            actuel = store.get(slot) or {}
            if (actuel.get("token") == creds["password"]
                    and actuel.get("uuid") == creds.get("uuid")):
                return connected

            store[slot] = {
                "token": creds["password"],
                "clientIdentifier": creds.get("client_identifier"),
                "uuid": creds.get("uuid"),
                "updatedAt": dt.datetime.now().isoformat(),
            }
            store["pronote_url"] = creds["pronote_url"]
            store["username"] = creds["username"]
            save_tokens(store)
        except Exception as exc:
            # Le filet de sécurité ne doit jamais interrompre une collecte —
            # mais il doit se faire entendre. Un jeton non persisté condamne
            # le compte au cycle suivant : ce n'est pas une trace de debug.
            warn("Persistance du jeton impossible :", exc)
        return connected

    clients.ClientBase._login = _login_and_persist
    _persist_hook_installed = True


# =====================================================================
# Helpers de conversion
# =====================================================================

def to_float(value, default=None):
    """
    Convertit une note Pronote en nombre.

    Pronote encode l'absence de note par "|1", "Absent", "NonNote"…
    Tout ce qui n'est pas numérique retourne `default`.
    """
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if not text or "|" in text:
        return default
    try:
        return float(text.replace(",", "."))
    except ValueError:
        return default


def iso(value):
    """datetime/date -> chaîne ISO. Node se charge du formatage localisé."""
    if value is None:
        return ""
    if isinstance(value, (dt.datetime, dt.date)):
        return value.isoformat()
    return str(value)


def clean_text(value):
    return re.sub(r"\s+", " ", str(value or "")).strip()


def as_date(value):
    return value.date() if isinstance(value, dt.datetime) else value


def is_parent_url(url):
    return "parent" in (url or "").lower()


def client_class(is_parent):
    return ParentClient if is_parent else Client


def describe_children(client):
    """[{name, className, establishment}] pour un compte parent."""
    out = []
    for child in getattr(client, "children", None) or []:
        out.append({
            "name": child.name,
            "className": getattr(child, "class_name", "") or "",
            "establishment": getattr(child, "establishment", "") or "",
        })
    return out


def select_child(client, child_name):
    """Sélectionne l'enfant demandé sur un compte parent (match partiel)."""
    if not isinstance(client, ParentClient):
        return
    children = client.children or []
    if not children:
        return
    if child_name:
        wanted = child_name.strip().lower()
        for child in children:
            if wanted in child.name.lower():
                client.set_child(child)
                log("Enfant sélectionné :", child.name)
                return
        log('Enfant "{}" introuvable — repli sur {}'.format(child_name, children[0].name))
    client.set_child(children[0])


def account_info(client):
    """Identité à afficher : l'enfant sélectionné sur un compte parent.

    `client.info` est construit une fois pour toutes dans `ClientBase._login`,
    à partir de la « ressource » renvoyée par ParametresUtilisateur — sur un
    compte parent, c'est le PARENT. `ParentClient.set_child()` remplace bien
    cette ressource pour les requêtes suivantes (`post()` signe avec
    `_selected_child.id`), mais ne retouche jamais `client.info`.

    Sans ce correctif, le module affiche donc le nom du titulaire du compte
    au-dessus de l'emploi du temps de son enfant — les données sont bonnes,
    l'identité ne l'est pas. Et sur un compte parent, `class_name` et
    `establishment` sont vides : l'en-tête perd aussi la classe et
    l'établissement.

    `_selected_child` est un attribut privé de pronotepy (vérifié sur 2.15.7).
    S'il disparaît d'une version future, on retombe sur `client.info` : un nom
    faux vaut mieux qu'un module qui cesse de s'afficher.
    """
    selected = getattr(client, "_selected_child", None)
    return selected if selected is not None else client.info


def require_login(client):
    """
    Garde-fou : pronotepy ne lève pas si l'authentification échoue, il pose
    seulement `logged_in = False`. Sans ce contrôle, le pont répondrait « OK »
    sans avoir la moindre session ouverte.
    """
    if not client.logged_in:
        raise AuthRefused(
            "Pronote a refusé la connexion (aucune session ouverte). "
            "Le QR Code a probablement déjà été utilisé ou a expiré."
        )
    return client


# =====================================================================
# Périodes
# =====================================================================

def covering_periods(client):
    """Sous-ensemble minimal de périodes couvrant la même plage de dates.

    Pronote publie une douzaine de découpages qui se recouvrent — « Année
    continue », semestres, trimestres, « DNB blanc », « Hors période »… Les
    absences, retards et punitions s'interrogent par plage de dates : les
    demander période par période renvoie douze fois les mêmes enregistrements,
    et chaque requête refusée pousse pronotepy à se ré-authentifier — donc à
    faire tourner le jeton. Accumulé, cela a déjà valu une suspension d'adresse
    IP par Pronote. (Mesure et algorithme repris de ProJote.)

    On retient la période la plus large, puis uniquement celles qui dépassent de
    la couverture déjà acquise.
    """
    valid = []
    for period in client.periods or []:
        start, end = as_date(getattr(period, "start", None)), as_date(getattr(period, "end", None))
        if start and end and end >= start:
            valid.append((start, end, period))
    if not valid:
        return list(client.periods or [])

    # Les périodes Pronote se suivent sans se chevaucher : un trimestre finit le
    # 23 novembre et le suivant commence le 24. Sans tolérance, la fusion verrait
    # un trou d'une journée entre deux périodes pourtant contiguës.
    tolerance = dt.timedelta(days=1)
    kept, coverage = [], []

    for start, end, period in sorted(valid, key=lambda v: v[1] - v[0], reverse=True):
        if any(lo <= start and end <= hi for lo, hi in coverage):
            continue
        kept.append(period)
        merged = []
        for lo, hi in sorted(coverage + [(start, end)]):
            if merged and lo <= merged[-1][1] + tolerance:
                merged[-1] = (merged[-1][0], max(merged[-1][1], hi))
            else:
                merged.append((lo, hi))
        coverage = merged

    if len(kept) < len(valid):
        log("Périodes : {} découpages publiés, {} suffisent à couvrir la plage.".format(
            len(valid), len(kept)))
    return kept


def current_period(client):
    """Période active — onglet Notes, avec replis successifs."""
    try:
        return client.current_period
    except Exception as exc:
        log("current_period indisponible :", exc)

    today = dt.date.today()
    periods = list(client.periods or [])
    for period in periods:
        if as_date(period.start) <= today <= as_date(period.end):
            return period
    return periods[-1] if periods else None


# =====================================================================
# Collecte des données
# =====================================================================

def map_lesson(lesson):
    if lesson.subject and lesson.subject.name:
        subject = lesson.subject.name
    elif lesson.detention:
        subject = "Retenue"
    else:
        subject = clean_text(lesson.status)

    return {
        "subject": subject,
        "teacher": ", ".join(lesson.teacher_names or []),
        "room": ", ".join(lesson.classrooms or []),
        "start": iso(lesson.start),
        "end": iso(lesson.end),
        "cancelled": bool(lesson.canceled),
        "isDetention": bool(lesson.detention),
        "status": clean_text(lesson.status),
    }


def collect_timetable(client, data, cfg):
    """Cours du jour + prochain jour scolaire (recherche sur 14 jours)."""
    today = dt.date.today()
    now = dt.datetime.now()

    lessons_today = sorted(client.lessons(today, today), key=lambda l: l.start)

    show_only_future = bool((cfg.get("Timetable") or {}).get("showOnlyFuture"))
    visible_today = [l for l in lessons_today if not show_only_future or l.end >= now]

    data["timetableToday"] = [map_lesson(l) for l in visible_today]
    data["cancelledToday"] = sum(1 for l in visible_today if l.canceled)
    data["todayStart"] = iso(lessons_today[0].start) if lessons_today else ""
    data["todayEnd"] = iso(lessons_today[-1].end) if lessons_today else ""
    data["noClassesToday"] = len(data["timetableToday"]) == 0

    # Prochain jour scolaire : pronotepy interroge une semaine par requête,
    # donc une seule plage de 14 jours remplace la boucle jour par jour.
    upcoming = sorted(
        client.lessons(today + dt.timedelta(days=1), today + dt.timedelta(days=14)),
        key=lambda l: l.start,
    )

    by_day = {}
    for lesson in upcoming:
        by_day.setdefault(lesson.start.date(), []).append(lesson)

    next_date, next_lessons = None, []
    for day in sorted(by_day):
        if any(not l.canceled for l in by_day[day]):
            next_date, next_lessons = day, by_day[day]
            break

    data["timetableNextDay"] = {
        "date": iso(next_date),
        "start": iso(next_lessons[0].start) if next_lessons else "",
        "end": iso(next_lessons[-1].end) if next_lessons else "",
        "daysUntil": (next_date - today).days if next_date else None,
        "classes": [map_lesson(l) for l in next_lessons],
    }

    log("EDT — aujourd'hui : {} cours | prochain jour : {} cours | vacances : {}".format(
        len(data["timetableToday"]), len(next_lessons), data["noClassesToday"]))


def collect_homeworks(client, data, cfg):
    today = dt.date.today()
    tomorrow = today + dt.timedelta(days=1)
    search = int((cfg.get("Homeworks") or {}).get("searchDays", 14))
    limit_date = today + dt.timedelta(days=search)

    homeworks = sorted(client.homework(today, limit_date), key=lambda h: h.date)
    data["homeworks"] = [{
        "subject": hw.subject.name if hw.subject else "",
        "description": clean_text(hw.description),
        "done": bool(hw.done),
        "deadline": iso(hw.date),
        "dueTomorrow": hw.date == tomorrow,
    } for hw in homeworks]

    pending = sum(1 for hw in data["homeworks"] if not hw["done"])
    log("Devoirs : {} ({} non faits)".format(len(data["homeworks"]), pending))


def collect_notebook(client, data, cfg):
    """Absences, retards et punitions sur les périodes couvrantes."""
    today = dt.date.today()

    def cutoff(section, default_days):
        return today - dt.timedelta(
            days=int((cfg.get(section) or {}).get("displayDuration", default_days)))

    def limit(section, default_count):
        return int((cfg.get(section) or {}).get("number", default_count))

    abs_cutoff, del_cutoff, pun_cutoff = (cutoff("Absences", 60),
                                          cutoff("Delays", 60),
                                          cutoff("Punishments", 60))
    absences, delays, punishments = [], [], []

    for period in covering_periods(client):
        for item in period.absences:
            if as_date(item.from_date) < abs_cutoff:
                continue
            absences.append({
                "date": iso(item.from_date),
                "endDate": iso(item.to_date or item.from_date),
                "reason": ", ".join(item.reasons) if item.reasons else "Non renseigné",
                "justified": bool(item.justified),
                "hours": item.hours or "",
                "days": item.days or 0,
            })
        for item in period.delays:
            if as_date(item.date) < del_cutoff:
                continue
            delays.append({
                "date": iso(item.date),
                "duration": item.minutes or 0,
                "justified": bool(item.justified),
                "reason": ", ".join(item.reasons) if item.reasons else "",
            })
        for item in period.punishments:
            if as_date(item.given) < pun_cutoff:
                continue
            punishments.append({
                "date": iso(item.given),
                "type": clean_text(item.nature) or "Punition",
                "reason": ", ".join(item.reasons) if item.reasons else "",
            })

    # Deux périodes couvrantes peuvent se recouper d'une journée : on dédoublonne.
    def dedupe(rows, *keys):
        seen, out = set(), []
        for row in sorted(rows, key=lambda r: r["date"], reverse=True):
            signature = tuple(row.get(k) for k in keys)
            if signature in seen:
                continue
            seen.add(signature)
            out.append(row)
        return out

    data["absences"] = dedupe(absences, "date", "endDate", "reason")[:limit("Absences", 5)]
    data["delays"] = dedupe(delays, "date", "duration")[:limit("Delays", 5)]
    data["punishments"] = dedupe(punishments, "date", "type", "reason")[:limit("Punishments", 5)]

    log("Absences : {} | Retards : {} | Punitions : {}".format(
        len(data["absences"]), len(data["delays"]), len(data["punishments"])))


def collect_grades(client, data, cfg):
    section = cfg.get("Grades") or {}
    cutoff = dt.date.today() - dt.timedelta(days=int(section.get("displayDuration", 30)))

    period = current_period(client)
    if period is None:
        log("Aucune période disponible — notes ignorées")
        return

    grades = []
    for item in period.grades:
        if item.date < cutoff:
            continue
        grades.append({
            "date": iso(item.date),
            "subject": item.subject.name if item.subject else "",
            "value": to_float(item.grade),
            "outOf": to_float(item.out_of, 20),
            "average": to_float(item.average),
            "coefficient": to_float(item.coefficient, 1),
            "comment": clean_text(item.comment),
        })
    grades.sort(key=lambda g: g["date"], reverse=True)
    data["grades"] = grades[:int(section.get("number", 10))]
    log("Notes :", len(data["grades"]))


def collect(client, cfg):
    """Assemble la charge utile envoyée au frontend (dates en ISO)."""
    info = account_info(client)
    data = {
        "name": info.name,
        "className": getattr(info, "class_name", "") or "",
        "establishment": getattr(info, "establishment", "") or "",
        "timetableToday": [],
        "timetableNextDay": {"date": "", "classes": []},
        "homeworks": [],
        "grades": [],
        "absences": [],
        "delays": [],
        "punishments": [],
    }
    log("Élève : {} — {} — {}".format(
        data["name"], data["className"], data["establishment"]))

    # Chaque bloc échoue indépendamment : un onglet désactivé par
    # l'établissement ne doit pas vider tout le reste.
    for label, action in (
        ("EDT", lambda: collect_timetable(client, data, cfg)),
        ("Devoirs", lambda: collect_homeworks(client, data, cfg)),
        ("Carnet", lambda: collect_notebook(client, data, cfg)),
        ("Notes", lambda: collect_grades(client, data, cfg)),
    ):
        try:
            action()
        except Exception as exc:
            log("{} indisponible :".format(label), exc)

    return data


# =====================================================================
# Erreurs
# =====================================================================

class NoTokens(Exception):
    pass


class AuthRefused(Exception):
    """Pronote a refusé la session sans lever d'exception dédiée."""


# Un incident réseau ou un serveur momentanément fermé n'invalide pas le jeton :
# rejouer avec le jeton de secours ne servirait à rien et brûlerait la réserve.
# Cas vécu : « Your IP address is suspended. » après trop de connexions.
_TRANSIENT_MARKERS = (
    "suspended", "suspendue", "timeout", "timed out", "connection",
    "unreachable", "unavailable", "indisponible", "momentan",
    "temporarily", "network",
)

# Signes que Pronote a bel et bien refusé le jeton. « datasec » couvre le cas où
# l'authentification est refusée sans exception dédiée : pronotepy échoue ensuite
# en lisant la réponse d'un login qui n'a pas eu lieu.
_AUTH_MARKERS = (
    "expir", "invalid", "refus", "unauthorized", "authenticat",
    "credentials", "datasec", "donneessec",
)


def is_token_error(exc):
    """Le jeton est-il en cause, ou s'agit-il d'un incident passager ?"""
    if exc is None:
        return True
    message = str(exc).lower()
    if any(marker in message for marker in _TRANSIENT_MARKERS):
        return False
    if isinstance(exc, (AuthRefused, ExpiredObject, CryptoError, QRCodeDecryptError)):
        return True
    return any(marker in message for marker in _AUTH_MARKERS)


def classify(exc):
    """Type d'erreur — Node s'en sert pour choisir le message affiché.

    Attention au piège : « Decryption failed while trying to un pad » recouvre
    deux cas opposés. QRCodeDecryptError vient du déchiffrement LOCAL du QR avec
    MD5(PIN) → le PIN est en cause. Une CryptoError nue vient du challenge
    d'authentification, franchi seulement si le PIN était bon → c'est le jeton
    du QR qui est refusé. Les confondre envoie l'utilisateur vérifier un PIN
    pourtant correct (cas vécu le 2 septembre 2026 sur ProJote).
    """
    if isinstance(exc, NoTokens):
        return "no_tokens"
    if isinstance(exc, QRCodeDecryptError):
        return "bad_pin"

    name = type(exc).__name__
    message = str(exc).lower()

    if "invalid confirmation code" in message:
        return "bad_pin"
    if isinstance(exc, CryptoError) or "padding is incorrect" in message or "decryption failed" in message:
        return "qr_expired"
    if "fromhex" in message or "non-hexadecimal" in message:
        return "bad_qr"
    # Jeton refusé sur un compte parent : pronotepy ne lève pas d'exception
    # dédiée. `_login()` rend False, `parametres_utilisateur` reste vide, et
    # `ParentClient.__init__` indexe le dictionnaire aussitôt — d'où un
    # KeyError('dataSec') levé DANS le constructeur, avant que
    # `require_login()` ait pu s'exécuter. Sans cette règle, l'utilisateur
    # lit « Erreur : 'dataSec' » là où il faut lui dire de rescanner un QR
    # Code. (Constaté en production le 2026-09-08.)
    if name == "KeyError" and ("datasec" in message or "donneessec" in message):
        return "auth_failed"
    # Les serveurs PRONOTE 2026 ne publient plus l'appel Start({...}) dans
    # l'attribut « onload » du <body> : pronotepy <= 2.14.6 échoue sur KeyError.
    if ((name == "KeyError" and "onload" in message)
            or "page html is different than expected" in message
            or "unable to connect to pronote" in message):
        return "outdated"
    if any(marker in message for marker in _TRANSIENT_MARKERS):
        return "network"
    if "Timeout" in name or "Connection" in name or "SSL" in name:
        return "network"
    if isinstance(exc, (AuthRefused, ExpiredObject, PronoteAPIError)):
        return "auth_failed"
    return "error"


# =====================================================================
# Actions
# =====================================================================

def _credentials_entry(client):
    creds = client.export_credentials()
    return {
        "token": creds["password"],
        "clientIdentifier": creds.get("client_identifier"),
        "uuid": creds.get("uuid"),
        "updatedAt": dt.datetime.now().isoformat(),
    }


def action_setup_qr(payload):
    """
    Connexion initiale par QR Code — seule méthode d'authentification.

    Le QR Code Pronote contient `login` et `jeton`, chiffrés en AES avec
    MD5(PIN) puis encodés en hexadécimal, ainsi que l'`url` de l'espace.
    Sa validité est de 10 minutes et il est à usage unique.
    """
    qr = payload.get("qr")
    if isinstance(qr, str):
        qr = json.loads(qr)
    qr = qr or {}
    pin = str(payload.get("pin") or "")

    missing = [key for key in ("login", "jeton", "url") if not qr.get(key)]
    if missing:
        raise ValueError(
            "QR Code incomplet — clés manquantes : {}".format(", ".join(missing)))

    # Validation AVANT d'appeler pronotepy : si l'image a été mal décodée côté
    # navigateur, on obtient ici des caractères non hexadécimaux et pronotepy
    # plante sur un « non-hexadecimal number found in fromhex() » peu parlant.
    for label, value in (("jeton", qr["jeton"]), ("login", qr["login"])):
        if not re.fullmatch(r"[0-9a-fA-F]+", str(value)):
            raise BadQRCode(
                "Contenu du QR Code illisible : « {} » n'est pas hexadécimal "
                "({} caractères). Le QR Code a probablement été mal décodé.".format(
                    label, len(str(value))))
    if not re.fullmatch(r"[0-9]{4}", pin):
        raise BadQRCode(
            "Code PIN invalide : 4 chiffres attendus (reçu {}).".format(len(pin)))

    is_parent = is_parent_url(qr["url"])
    cls = client_class(is_parent)
    device_uuid = get_device_uuid()
    log("Connexion QR Code — espace {}".format("parent" if is_parent else "élève"))

    client = require_login(cls.qrcode_login(
        qr, pin, device_uuid, device_name="MagicMirror"))

    child_name = payload.get("childName") or ""
    select_child(client, child_name)

    store = {
        "pronote_url": client.pronote_url,
        "username": client.username,
        "isParent": is_parent,
        "childName": child_name,
        "children": describe_children(client) if is_parent else [],
        "deviceUUID": device_uuid,
        "primary": _credentials_entry(client),
        "backup": _make_backup(cls, client, pin, device_uuid, is_parent),
    }
    save_tokens(store)
    log("QR OK — {} (parent : {})".format(store["username"], is_parent))

    return {
        "username": store["username"],
        "isParent": is_parent,
        "children": store["children"],
        "hasBackup": bool(store["backup"]),
    }


def _make_backup(cls, client, pin, device_uuid, is_parent):
    """
    Enregistre un SECOND appareil, avec son propre jeton indépendant.

    PRONOTE n'accepte que le dernier jeton émis pour un appareil donné : un
    « ancien jeton » gardé de côté est déjà mort. Un vrai filet de sécurité
    suppose donc un second appareil, d'où l'UUID distinct suffixé « -bk ».

    Toutes les instances ne le permettent pas : depuis une session déjà issue
    d'un QR Code, `JetonAppliMobile` peut répondre sans « jeton » ni « login ».
    L'échec est alors sans conséquence — la connexion principale est acquise.
    """
    try:
        qr_backup = client.request_qr_code_data(pin)
        missing = [k for k in ("jeton", "login", "url")
                   if not (isinstance(qr_backup, dict) and qr_backup.get(k))]
        if missing:
            log("Jeton de secours non généré : cette instance n'émet pas de second "
                "QR Code (champs manquants : {}). La reconnexion utilisera le jeton "
                "principal.".format(", ".join(missing)))
            return None

        backup = cls.qrcode_login(qr_backup, pin, device_uuid + "-bk",
                                  device_name="MagicMirror (secours)")
        if not backup.logged_in:
            log("Jeton de secours refusé par Pronote — ignoré.")
            return None
        log("Jeton de secours généré.")
        return _credentials_entry(backup)
    except Exception as exc:
        log("Génération du jeton de secours échouée :", exc)
        return None


def _login_with_token(tokens, entry, child_name):
    cls = client_class(tokens.get("isParent"))
    client = require_login(cls.token_login(
        tokens["pronote_url"],
        tokens["username"],
        entry["token"],
        entry.get("uuid") or tokens.get("deviceUUID") or get_device_uuid(),
        client_identifier=entry.get("clientIdentifier") or None,
        device_name="MagicMirror",
    ))
    select_child(client, child_name)
    return client


def action_fetch(payload):
    install_token_persistence()

    tokens = load_tokens()
    if not tokens or not (tokens.get("primary") or {}).get("token"):
        raise NoTokens("Aucun jeton configuré.")

    cfg = payload.get("config") or {}
    child_name = payload.get("childName") or tokens.get("childName") or ""

    try:
        log("Connexion — jeton principal (enfant : {})".format(child_name or "auto"))
        client = _login_with_token(tokens, tokens["primary"], child_name)
    except Exception as first_error:
        log("Jeton principal refusé :", first_error)

        # Le secours n'est consommé que si le jeton est réellement en cause.
        # Sur une panne réseau ou une IP suspendue, le principal reste valide.
        if not is_token_error(first_error):
            raise
        if not (tokens.get("backup") or {}).get("token"):
            raise
        log("Bascule sur l'appareil de secours…")
        client = _login_with_token(tokens, tokens["backup"], child_name)
        # Le secours devient l'appareil principal : sans cette promotion, le
        # jeton principal mort serait retenté à chaque cycle.
        tokens = load_tokens() or tokens
        # On RETIRE la clé au lieu d'y écrire None : un None laissé en place
        # est un piège pour tout code qui ferait `store.get("backup", {})`,
        # lequel rendrait None et non le défaut.
        tokens["primary"] = tokens.get("backup")
        tokens.pop("backup", None)
        save_tokens(tokens)
        log("Appareil de secours promu principal.")

    data = collect(client, cfg)
    data["childName"] = child_name
    data["children"] = (load_tokens() or {}).get("children") or []
    return data


class BadQRCode(Exception):
    pass


ACTIONS = {
    "setup_qr": action_setup_qr,
    "fetch": action_fetch,
}


def main():
    try:
        # lstrip : certains appelants préfixent un BOM UTF-8.
        payload = json.loads(sys.stdin.read().lstrip("﻿") or "{}")
    except ValueError as exc:
        print(json.dumps({"ok": False, "kind": "error",
                          "error": "Commande illisible : {}".format(exc)}))
        return

    # Avant toute chose : sur quel compte porte cette invocation.
    compte = set_account(payload.get("account"))
    if compte != ACCOUNT_DEFAULT:
        log("Compte :", compte)

    action = ACTIONS.get(payload.get("action"))
    if action is None:
        print(json.dumps({"ok": False, "kind": "error",
                          "error": "Action inconnue : {}".format(payload.get("action"))}))
        return

    try:
        result = action(payload)
        print(json.dumps({"ok": True, "data": result},
                         ensure_ascii=False, default=str))
    except BadQRCode as exc:
        print(json.dumps({"ok": False, "kind": "bad_qr", "error": str(exc)},
                         ensure_ascii=False))
    except ChildNotFound as exc:
        print(json.dumps({"ok": False, "kind": "error", "error": str(exc)},
                         ensure_ascii=False))
    except Exception as exc:
        log(traceback.format_exc())
        print(json.dumps({"ok": False, "kind": classify(exc),
                          "error": str(exc) or type(exc).__name__},
                         ensure_ascii=False))


if __name__ == "__main__":
    main()
