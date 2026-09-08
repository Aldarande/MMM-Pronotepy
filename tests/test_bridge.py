# -*- coding: utf-8 -*-
# MMM-Pronotepy — module MagicMirror² pour Pronote
# Copyright (C) 2024-2026 Aldarande
# Licensed under the MIT License. See LICENSE for details.
"""
Tests des fonctions pures de `pronote_bridge.py`.

Aucun réseau, aucun compte Pronote : les clients sont remplacés par les
doubles de conftest.py. Ce qui est éprouvé ici, ce sont les décisions que le
pont prend seul — sérialisation des devoirs, notes et absences, normalisation
des dates, et classement des erreurs — c'est-à-dire tout ce qu'un
rafraîchissement en production ne montre qu'après coup, et sur un seul cas.
"""

import datetime as dt
import json
import os
import sys

import pytest

from conftest import (Absence, Delay, FakeClient, Grade, Homework, Lesson,
                      Nomme, Period, Punishment)


# ─────────────────────────────────────────────────────────────────────────────
# Conversions
# ─────────────────────────────────────────────────────────────────────────────

class TestToFloat:
    """Pronote encode l'absence de note par des marqueurs, pas par du vide."""

    @pytest.mark.parametrize("brut,attendu", [
        (15, 15.0),
        (15.5, 15.5),
        ("15", 15.0),
        ("15,5", 15.5),        # séparateur décimal français
        ("  12  ", 12.0),
    ])
    def test_valeurs_numeriques(self, bridge, brut, attendu):
        assert bridge.to_float(brut) == attendu

    @pytest.mark.parametrize("brut", ["|1", "|2", "Absent", "NonNote", "", "   ", None])
    def test_non_notes_retournent_le_defaut(self, bridge, brut):
        assert bridge.to_float(brut) is None
        assert bridge.to_float(brut, 20) == 20

    def test_zero_reste_zero(self, bridge):
        """Un 0/20 est une note, pas une absence de note."""
        assert bridge.to_float("0") == 0.0
        assert bridge.to_float(0, 20) == 0.0


class TestIso:
    def test_datetime(self, bridge):
        assert bridge.iso(dt.datetime(2026, 9, 5, 8, 30)) == "2026-09-05T08:30:00"

    def test_date(self, bridge):
        assert bridge.iso(dt.date(2026, 9, 5)) == "2026-09-05"

    def test_none_devient_chaine_vide(self, bridge):
        """Node teste la vérité de la chaîne : None y deviendrait « null ». """
        assert bridge.iso(None) == ""

    def test_chaine_passe_telle_quelle(self, bridge):
        assert bridge.iso("2026-09-05") == "2026-09-05"


class TestCleanText:
    @pytest.mark.parametrize("brut,attendu", [
        ("  Devoir   maison \n sur les fractions ", "Devoir maison sur les fractions"),
        ("Ligne1\r\nLigne2", "Ligne1 Ligne2"),
        (None, ""),
        ("", ""),
    ])
    def test_normalisation(self, bridge, brut, attendu):
        assert bridge.clean_text(brut) == attendu


class TestAsDate:
    def test_datetime_devient_date(self, bridge):
        assert bridge.as_date(dt.datetime(2026, 9, 5, 14, 0)) == dt.date(2026, 9, 5)

    def test_date_inchangee(self, bridge):
        jour = dt.date(2026, 9, 5)
        assert bridge.as_date(jour) is jour


def test_is_parent_url(bridge):
    assert bridge.is_parent_url("https://x.index-education.net/pronote/mobile.parent.html")
    assert bridge.is_parent_url("HTTPS://X/PRONOTE/PARENT")
    assert not bridge.is_parent_url("https://x.index-education.net/pronote/eleve.html")
    assert not bridge.is_parent_url(None)


# ─────────────────────────────────────────────────────────────────────────────
# Emploi du temps
# ─────────────────────────────────────────────────────────────────────────────

def _cours(jour, heure, **kw):
    debut = dt.datetime.combine(jour, dt.time(heure, 0))
    return Lesson(debut, debut + dt.timedelta(hours=1), **kw)


class TestMapLesson:
    def test_matiere_normale(self, bridge, aujourdhui):
        cours = _cours(aujourdhui, 8, subject="Mathématiques",
                       teacher_names=["M. Durand"], classrooms=["B12"])
        vu = bridge.map_lesson(cours)
        assert vu["subject"] == "Mathématiques"
        assert vu["teacher"] == "M. Durand"
        assert vu["room"] == "B12"
        assert vu["cancelled"] is False
        assert vu["start"].startswith(aujourdhui.isoformat())

    def test_retenue_sans_matiere(self, bridge, aujourdhui):
        """Une retenue n'a pas de matière : sans repli, la ligne serait vide."""
        cours = _cours(aujourdhui, 17, detention=True)
        assert bridge.map_lesson(cours)["subject"] == "Retenue"
        assert bridge.map_lesson(cours)["isDetention"] is True

    def test_repli_sur_le_statut(self, bridge, aujourdhui):
        cours = _cours(aujourdhui, 10, status="  Cours   annulé ")
        assert bridge.map_lesson(cours)["subject"] == "Cours annulé"

    def test_plusieurs_professeurs_et_salles(self, bridge, aujourdhui):
        cours = _cours(aujourdhui, 9, subject="SVT",
                       teacher_names=["Mme A", "M. B"], classrooms=["S1", "S2"])
        vu = bridge.map_lesson(cours)
        assert vu["teacher"] == "Mme A, M. B"
        assert vu["room"] == "S1, S2"


class TestCollectTimetable:
    def test_journee_ordinaire(self, bridge, aujourdhui):
        client = FakeClient(lessons=[
            _cours(aujourdhui, 10, subject="Histoire"),
            _cours(aujourdhui, 8, subject="Maths"),
        ])
        data = {}
        bridge.collect_timetable(client, data, {})

        assert [c["subject"] for c in data["timetableToday"]] == ["Maths", "Histoire"]
        assert data["noClassesToday"] is False
        assert data["todayStart"].endswith("T08:00:00")
        assert data["todayEnd"].endswith("T11:00:00")

    def test_jour_sans_cours(self, bridge):
        data = {}
        bridge.collect_timetable(FakeClient(), data, {})
        assert data["timetableToday"] == []
        assert data["noClassesToday"] is True
        assert data["todayStart"] == ""
        assert data["timetableNextDay"]["daysUntil"] is None

    def test_show_only_future_masque_les_cours_termines(self, bridge, aujourdhui):
        maintenant = dt.datetime.now()
        passe = Lesson(maintenant - dt.timedelta(hours=2),
                       maintenant - dt.timedelta(hours=1), subject="Passé")
        futur = Lesson(maintenant + dt.timedelta(hours=1),
                       maintenant + dt.timedelta(hours=2), subject="Futur")
        client = FakeClient(lessons=[passe, futur])

        data = {}
        bridge.collect_timetable(client, data, {"Timetable": {"showOnlyFuture": True}})
        assert [c["subject"] for c in data["timetableToday"]] == ["Futur"]

        # todayStart reste l'ouverture réelle de la journée, filtre ou pas :
        # c'est l'horaire d'entrée au collège, pas le prochain cours.
        assert data["todayStart"] == bridge.iso(passe.start)

    def test_cours_annules_comptes_mais_affiches(self, bridge, aujourdhui):
        client = FakeClient(lessons=[
            _cours(aujourdhui, 8, subject="Maths", canceled=True),
            _cours(aujourdhui, 9, subject="Anglais"),
        ])
        data = {}
        bridge.collect_timetable(client, data, {})
        assert data["cancelledToday"] == 1
        assert len(data["timetableToday"]) == 2

    def test_prochain_jour_saute_une_journee_entierement_annulee(self, bridge, aujourdhui):
        """Un jour dont tous les cours sont annulés n'est pas un jour de classe."""
        demain = aujourdhui + dt.timedelta(days=1)
        surlendemain = aujourdhui + dt.timedelta(days=2)
        client = FakeClient(lessons=[
            _cours(demain, 8, subject="Maths", canceled=True),
            _cours(surlendemain, 9, subject="Physique"),
        ])
        data = {}
        bridge.collect_timetable(client, data, {})

        suivant = data["timetableNextDay"]
        assert suivant["daysUntil"] == 2
        assert [c["subject"] for c in suivant["classes"]] == ["Physique"]

    def test_une_seule_requete_de_quatorze_jours(self, bridge, aujourdhui):
        """pronotepy interroge une semaine par appel : une boucle jour par jour
        multiplierait les requêtes — et les rotations de jeton avec."""
        client = FakeClient()
        bridge.collect_timetable(client, {}, {})

        assert len(client.calls["lessons"]) == 2          # aujourd'hui + la plage
        debut, fin = client.calls["lessons"][1]
        assert (fin - debut).days == 13


# ─────────────────────────────────────────────────────────────────────────────
# Devoirs
# ─────────────────────────────────────────────────────────────────────────────

class TestCollectHomeworks:
    def test_serialisation(self, bridge, aujourdhui):
        demain = aujourdhui + dt.timedelta(days=1)
        client = FakeClient(homeworks=[
            Homework(aujourdhui + dt.timedelta(days=3), "Anglais", "Lire\n  p. 42", done=True),
            Homework(demain, "Maths", "Exercices 1 à 5"),
        ])
        data = {}
        bridge.collect_homeworks(client, data, {})

        assert [h["subject"] for h in data["homeworks"]] == ["Maths", "Anglais"]
        premier = data["homeworks"][0]
        assert premier["dueTomorrow"] is True
        assert premier["done"] is False
        assert premier["deadline"] == demain.isoformat()
        assert data["homeworks"][1]["description"] == "Lire p. 42"
        assert data["homeworks"][1]["dueTomorrow"] is False

    def test_search_days_borne_la_plage(self, bridge, aujourdhui):
        client = FakeClient(homeworks=[
            Homework(aujourdhui + dt.timedelta(days=3), "Maths"),
            Homework(aujourdhui + dt.timedelta(days=20), "Trop loin"),
        ])
        data = {}
        bridge.collect_homeworks(client, data, {"Homeworks": {"searchDays": 7}})
        assert [h["subject"] for h in data["homeworks"]] == ["Maths"]

    def test_devoir_sans_matiere(self, bridge, aujourdhui):
        client = FakeClient(homeworks=[Homework(aujourdhui, "", "Rien")])
        data = {}
        bridge.collect_homeworks(client, data, {})
        assert data["homeworks"][0]["subject"] == ""


# ─────────────────────────────────────────────────────────────────────────────
# Notes
# ─────────────────────────────────────────────────────────────────────────────

class TestCollectGrades:
    def test_serialisation_et_tri(self, bridge, aujourdhui):
        periode = Period(aujourdhui - dt.timedelta(days=60), aujourdhui, grades=[
            Grade(aujourdhui - dt.timedelta(days=5), "Maths", "15,5", "20", "12", "2", " Bon  travail "),
            Grade(aujourdhui - dt.timedelta(days=1), "SVT", "8", "10", "6,5", "1"),
        ])
        client = FakeClient(periods=[periode], current=periode)
        data = {}
        bridge.collect_grades(client, data, {})

        assert [g["subject"] for g in data["grades"]] == ["SVT", "Maths"]   # plus récente d'abord
        maths = data["grades"][1]
        assert maths["value"] == 15.5
        assert maths["outOf"] == 20.0
        assert maths["coefficient"] == 2.0
        assert maths["comment"] == "Bon travail"

    def test_note_absente_serialisee_a_none(self, bridge, aujourdhui):
        """« |1 » signifie « pas de note » : la valeur doit être nulle, pas 1."""
        periode = Period(aujourdhui - dt.timedelta(days=60), aujourdhui, grades=[
            Grade(aujourdhui, "Maths", grade="|1", out_of="|1", average="|1"),
        ])
        client = FakeClient(periods=[periode], current=periode)
        data = {}
        bridge.collect_grades(client, data, {})

        note = data["grades"][0]
        assert note["value"] is None
        assert note["average"] is None
        assert note["outOf"] == 20.0      # le défaut, pour ne pas afficher « /None »

    def test_duree_et_nombre(self, bridge, aujourdhui):
        grades = [Grade(aujourdhui - dt.timedelta(days=n), "M%d" % n) for n in range(0, 40)]
        periode = Period(aujourdhui - dt.timedelta(days=90), aujourdhui, grades=grades)
        client = FakeClient(periods=[periode], current=periode)

        data = {}
        bridge.collect_grades(client, data, {"Grades": {"displayDuration": 10, "number": 3}})
        assert len(data["grades"]) == 3
        assert data["grades"][0]["subject"] == "M0"

    def test_aucune_periode_laisse_la_cle_absente(self, bridge):
        """Sans période, on ne pose pas de tableau vide : `collect` a déjà
        initialisé la clé, et l'écraser masquerait la distinction."""
        data = {}
        bridge.collect_grades(FakeClient(), data, {})
        assert "grades" not in data


# ─────────────────────────────────────────────────────────────────────────────
# Vie scolaire
# ─────────────────────────────────────────────────────────────────────────────

class TestCollectNotebook:
    def test_serialisation(self, bridge, aujourdhui):
        periode = Period(
            aujourdhui - dt.timedelta(days=90), aujourdhui,
            absences=[Absence(dt.datetime.combine(aujourdhui - dt.timedelta(days=2), dt.time(8)),
                              dt.datetime.combine(aujourdhui - dt.timedelta(days=2), dt.time(12)),
                              reasons=["Maladie"], justified=True, hours="4h", days=1)],
            delays=[Delay(dt.datetime.combine(aujourdhui - dt.timedelta(days=1), dt.time(8, 10)),
                          minutes=10, justified=False, reasons=["Transport"])],
            punishments=[Punishment(dt.datetime.combine(aujourdhui, dt.time(17)),
                                    nature="  Retenue  ", reasons=["Bavardage"])],
        )
        client = FakeClient(periods=[periode])
        data = {}
        bridge.collect_notebook(client, data, {})

        absence = data["absences"][0]
        assert absence["reason"] == "Maladie"
        assert absence["justified"] is True
        assert absence["hours"] == "4h"

        assert data["delays"][0]["duration"] == 10
        assert data["punishments"][0]["type"] == "Retenue"

    def test_absence_sans_motif(self, bridge, aujourdhui):
        periode = Period(aujourdhui - dt.timedelta(days=90), aujourdhui,
                         absences=[Absence(aujourdhui, reasons=[])])
        data = {}
        bridge.collect_notebook(FakeClient(periods=[periode]), data, {})
        assert data["absences"][0]["reason"] == "Non renseigné"
        # to_date absent : on retombe sur from_date plutôt que sur une chaîne vide
        assert data["absences"][0]["endDate"] == aujourdhui.isoformat()

    def test_anciennete_filtree(self, bridge, aujourdhui):
        periode = Period(aujourdhui - dt.timedelta(days=400), aujourdhui, absences=[
            Absence(aujourdhui - dt.timedelta(days=5)),
            Absence(aujourdhui - dt.timedelta(days=200)),
        ])
        data = {}
        bridge.collect_notebook(FakeClient(periods=[periode]), data,
                                {"Absences": {"displayDuration": 30}})
        assert len(data["absences"]) == 1

    def test_dedoublonnage_entre_periodes_qui_se_recouvrent(self, bridge, aujourdhui):
        """Deux découpages Pronote peuvent porter la même absence ; sans
        dédoublonnage, elle s'afficherait deux fois."""
        jour = aujourdhui - dt.timedelta(days=3)
        doublon = lambda: Absence(jour, jour, reasons=["Maladie"])
        # Le semestre couvre le trimestre : covering_periods ne devrait garder
        # que le premier — ce test vérifie la ceinture ET les bretelles.
        semestre = Period(aujourdhui - dt.timedelta(days=90), aujourdhui,
                          name="S1", absences=[doublon()])
        trimestre = Period(aujourdhui - dt.timedelta(days=90), aujourdhui,
                           name="T1", absences=[doublon()])
        data = {}
        bridge.collect_notebook(FakeClient(periods=[semestre, trimestre]), data, {})
        assert len(data["absences"]) == 1

    def test_nombre_maximum(self, bridge, aujourdhui):
        periode = Period(aujourdhui - dt.timedelta(days=90), aujourdhui, delays=[
            Delay(aujourdhui - dt.timedelta(days=n), minutes=n) for n in range(1, 10)
        ])
        data = {}
        bridge.collect_notebook(FakeClient(periods=[periode]), data,
                                {"Delays": {"number": 2}})
        assert len(data["delays"]) == 2
        # les plus récents d'abord
        assert data["delays"][0]["duration"] == 1


class TestCoveringPeriods:
    def test_garde_le_sous_ensemble_couvrant(self, bridge, aujourdhui):
        """Pronote publie une douzaine de découpages qui se recouvrent ;
        les interroger tous multiplie les requêtes — et les rotations de jeton."""
        annee = Period(dt.date(2026, 9, 1), dt.date(2027, 7, 4), name="Année")
        t1 = Period(dt.date(2026, 9, 1), dt.date(2026, 11, 23), name="T1")
        t2 = Period(dt.date(2026, 11, 24), dt.date(2027, 3, 7), name="T2")

        gardees = bridge.covering_periods(FakeClient(periods=[t1, annee, t2]))
        assert [p.name for p in gardees] == ["Année"]

    def test_periodes_contigues_fusionnent(self, bridge):
        """Un trimestre finit le 23 et le suivant commence le 24 : sans la
        tolérance d'un jour, la fusion verrait un trou."""
        t1 = Period(dt.date(2026, 9, 1), dt.date(2026, 11, 23), name="T1")
        t2 = Period(dt.date(2026, 11, 24), dt.date(2027, 3, 7), name="T2")
        hors = Period(dt.date(2026, 9, 1), dt.date(2027, 3, 7), name="Hors période")

        gardees = bridge.covering_periods(FakeClient(periods=[t1, t2, hors]))
        assert [p.name for p in gardees] == ["Hors période"]

    def test_periodes_incoherentes_ignorees(self, bridge):
        """Une période dont la fin précède le début (vu sur « DNB blanc »)
        ne doit ni planter ni fausser la couverture."""
        bancale = Period(dt.date(2027, 1, 1), dt.date(2026, 1, 1), name="Bancale")
        bonne = Period(dt.date(2026, 9, 1), dt.date(2027, 7, 4), name="Année")
        assert [p.name for p in bridge.covering_periods(
            FakeClient(periods=[bancale, bonne]))] == ["Année"]

    def test_sans_dates_exploitables_on_rend_tout(self, bridge):
        sans_dates = Period(None, None, name="?")
        assert bridge.covering_periods(FakeClient(periods=[sans_dates])) == [sans_dates]


class TestCurrentPeriod:
    def test_repli_sur_la_periode_qui_contient_aujourdhui(self, bridge, aujourdhui):
        """`client.current_period` lève sur certains comptes parents."""
        passee = Period(aujourdhui - dt.timedelta(days=200), aujourdhui - dt.timedelta(days=100))
        courante = Period(aujourdhui - dt.timedelta(days=10), aujourdhui + dt.timedelta(days=10))
        client = FakeClient(periods=[passee, courante])   # current_period lève
        assert bridge.current_period(client) is courante

    def test_repli_final_sur_la_derniere(self, bridge, aujourdhui):
        ancienne = Period(aujourdhui - dt.timedelta(days=400), aujourdhui - dt.timedelta(days=300))
        assert bridge.current_period(FakeClient(periods=[ancienne])) is ancienne

    def test_aucune_periode(self, bridge):
        assert bridge.current_period(FakeClient()) is None


# ─────────────────────────────────────────────────────────────────────────────
# Sélection d'enfant (comptes parents)
# ─────────────────────────────────────────────────────────────────────────────

class TestSelectChild:
    def _parent(self, bridge, noms):
        parent = bridge.ParentClient()
        parent.children = [Nomme(n) for n in noms]
        parent._selected_child = None
        return parent

    def test_correspondance_partielle(self, bridge):
        parent = self._parent(bridge, ["Hugo MARTIN", "Alice MARTIN"])
        bridge.select_child(parent, "alice")
        assert parent._selected_child.name == "Alice MARTIN"

    def test_enfant_introuvable_repli_sur_le_premier(self, bridge):
        """Un prénom mal orthographié dans config.js ne doit pas laisser le
        module vide : on affiche le premier enfant plutôt que rien."""
        parent = self._parent(bridge, ["Hugo MARTIN", "Alice MARTIN"])
        bridge.select_child(parent, "Inconnu")
        assert parent._selected_child.name == "Hugo MARTIN"

    def test_sans_nom_demande(self, bridge):
        parent = self._parent(bridge, ["Hugo MARTIN"])
        bridge.select_child(parent, "")
        assert parent._selected_child.name == "Hugo MARTIN"

    def test_compte_eleve_ignore(self, bridge):
        eleve = FakeClient()
        bridge.select_child(eleve, "Hugo")      # ne doit pas lever


def test_describe_children(bridge):
    parent = bridge.ParentClient()
    enfant = Nomme("Hugo MARTIN")
    enfant.class_name = "5B"
    enfant.establishment = "Collège Victor Hugo"
    parent.children = [enfant]

    assert bridge.describe_children(parent) == [{
        "name": "Hugo MARTIN",
        "className": "5B",
        "establishment": "Collège Victor Hugo",
    }]


def test_require_login_leve_si_session_absente(bridge):
    """pronotepy ne lève pas quand l'authentification échoue : il pose
    `logged_in = False`. Sans ce garde-fou, le pont répondrait « OK »."""
    client = FakeClient()
    client.logged_in = False
    with pytest.raises(bridge.AuthRefused):
        bridge.require_login(client)

    client.logged_in = True
    assert bridge.require_login(client) is client


# ─────────────────────────────────────────────────────────────────────────────
# Identité affichée
# ─────────────────────────────────────────────────────────────────────────────

class TestAccountInfo:
    """Sur un compte parent, `client.info` reste le PARENT.

    pronotepy fige `info` dans `_login` a partir de la « ressource » du
    compte, et `set_child()` ne la retouche pas — seules les requetes suivent
    l enfant. Le module affichait donc le nom du titulaire au-dessus de
    l emploi du temps de son enfant (constate en production le 2026-09-08).
    """

    def test_compte_eleve_inchange(self, bridge):
        client = FakeClient(info=Nomme("Alice MARTIN"))
        assert bridge.account_info(client).name == "Alice MARTIN"

    def test_compte_parent_rend_l_enfant_selectionne(self, bridge):
        parent = bridge.ParentClient()
        parent.info = Nomme("M. MARTIN Jean")          # identite du titulaire
        enfant = Nomme("Alice MARTIN")
        parent.children = [enfant]
        bridge.select_child(parent, "alice")

        assert bridge.account_info(parent).name == "Alice MARTIN"

    def test_repli_si_pronotepy_renomme_l_attribut(self, bridge):
        """`_selected_child` est prive. S il disparait, on veut un nom faux
        plutot qu un module qui cesse de s afficher."""
        parent = bridge.ParentClient()
        parent.info = Nomme("M. MARTIN Jean")
        parent._selected_child = None

        assert bridge.account_info(parent).name == "M. MARTIN Jean"

    def test_collect_publie_l_identite_de_l_enfant(self, bridge, aujourdhui):
        """Le bout du fil : c est ce que le frontend affiche en en-tete."""
        enfant = Nomme("Alice MARTIN")
        enfant.class_name = "3B"
        enfant.establishment = "College Victor Hugo"

        parent = bridge.ParentClient()
        parent.info = Nomme("M. MARTIN Jean")          # sans classe ni etablissement
        parent.children = [enfant]
        parent.periods = []
        parent.logged_in = True
        parent.lessons = lambda debut, fin=None: []
        parent.homework = lambda debut, fin=None: []
        bridge.select_child(parent, "Alice")

        data = bridge.collect(parent, {})
        assert data["name"] == "Alice MARTIN"
        assert data["className"] == "3B"
        assert data["establishment"] == "College Victor Hugo"


# ─────────────────────────────────────────────────────────────────────────────
# Classement des erreurs
# ─────────────────────────────────────────────────────────────────────────────

class TestClassify:
    def test_pin_et_qr_ne_se_confondent_pas(self, bridge):
        """Les deux remontent du même échec AES ; les confondre envoie
        l'utilisateur vérifier un PIN pourtant correct (vécu le 2026-09-02)."""
        import pronotepy.exceptions as exc

        pin_faux = exc.QRCodeDecryptError("Decryption failed while trying to un pad")
        qr_perime = exc.CryptoError("Decryption failed while trying to un pad")

        assert bridge.classify(pin_faux) == "bad_pin"
        assert bridge.classify(qr_perime) == "qr_expired"

    @pytest.mark.parametrize("message,attendu", [
        ("Invalid confirmation code", "bad_pin"),
        ("non-hexadecimal number found in fromhex()", "bad_qr"),
        ("Page HTML is different than expected", "outdated"),
        ("Unable to connect to Pronote", "outdated"),
        ("Your IP address is suspended.", "network"),
        ("connection timed out", "network"),
        ("Service momentanément indisponible", "network"),
    ])
    def test_messages(self, bridge, message, attendu):
        assert bridge.classify(Exception(message)) == attendu

    def test_keyerror_onload_signale_pronotepy_trop_ancien(self, bridge):
        """pronotepy <= 2.14.6 échoue ainsi sur les serveurs PRONOTE 2026 ;
        c'est ce qui justifie le plancher de requirements.txt."""
        assert bridge.classify(KeyError("onload")) == "outdated"

    def test_jeton_refuse_sur_compte_parent(self, bridge):
        """pronotepy ne leve pas d exception dediee : `_login()` rend False,
        `parametres_utilisateur` reste vide, et `ParentClient.__init__`
        l indexe aussitot. Sans cette regle, l utilisateur lit
        « Erreur : 'dataSec' » au lieu de « rescannez un QR Code »."""
        assert bridge.classify(KeyError("dataSec")) == "auth_failed"
        assert bridge.classify(KeyError("donneesSec")) == "auth_failed"

    def test_no_tokens(self, bridge):
        assert bridge.classify(bridge.NoTokens()) == "no_tokens"

    def test_auth_refusee(self, bridge):
        import pronotepy.exceptions as exc
        assert bridge.classify(bridge.AuthRefused("refus")) == "auth_failed"
        assert bridge.classify(exc.ExpiredObject("expiré")) == "auth_failed"
        assert bridge.classify(exc.PronoteAPIError("bizarre")) == "auth_failed"

    def test_inconnu(self, bridge):
        assert bridge.classify(ValueError("quelque chose d'autre")) == "error"


class TestIsTokenError:
    def test_incident_reseau_ne_brule_pas_la_reserve(self, bridge):
        """Un serveur momentanément fermé n'invalide pas le jeton : rejouer
        avec le jeton de secours le consommerait pour rien."""
        assert bridge.is_token_error(Exception("Your IP address is suspended.")) is False
        assert bridge.is_token_error(Exception("connection reset")) is False

    def test_marqueur_transitoire_prime_sur_le_marqueur_auth(self, bridge):
        """« invalid » est un marqueur d'auth, « timeout » un marqueur
        transitoire : le second doit gagner, sinon on brûle le secours."""
        assert bridge.is_token_error(Exception("invalid response after timeout")) is False

    def test_refus_authentification(self, bridge):
        import pronotepy.exceptions as exc
        assert bridge.is_token_error(exc.ExpiredObject("expired")) is True
        assert bridge.is_token_error(Exception("Token expiré")) is True
        assert bridge.is_token_error(Exception("DonneesSec absent")) is True

    def test_sans_exception(self, bridge):
        assert bridge.is_token_error(None) is True


# ─────────────────────────────────────────────────────────────────────────────
# Stockage des jetons
# ─────────────────────────────────────────────────────────────────────────────

class TestStockage:
    def test_ecriture_atomique_et_relecture(self, bridge, tmp_path, monkeypatch):
        cible = tmp_path / "cache" / "tokens.json"
        monkeypatch.setattr(bridge, "TOKEN_FILE", str(cible))

        bridge.save_tokens({"username": "hugo.martin", "primary": {"token": "abc"}})
        assert bridge.load_tokens()["username"] == "hugo.martin"
        assert not os.path.exists(str(cible) + ".tmp")   # le .tmp a bien été renommé

    @pytest.mark.skipif(sys.platform == "win32",
                        reason="NTFS n'a pas de bits de permission POSIX")
    def test_jetons_illisibles_par_les_autres(self, bridge, tmp_path, monkeypatch):
        """Le fichier porte le jeton de reconnexion : quiconque le lit se
        connecte au compte Pronote. Attendu : -rw------- (0600)."""
        cible = tmp_path / "tokens.json"
        monkeypatch.setattr(bridge, "TOKEN_FILE", str(cible))
        bridge.save_tokens({"primary": {"token": "secret"}})
        assert oct(os.stat(str(cible)).st_mode & 0o777) == "0o600"

    def test_reprise_sur_le_fichier_temporaire(self, bridge, tmp_path, monkeypatch):
        """Coupure de courant entre le fsync et le rename : le .tmp contient le
        dernier jeton émis. Le perdre imposerait de rescanner un QR Code."""
        cible = tmp_path / "tokens.json"
        monkeypatch.setattr(bridge, "TOKEN_FILE", str(cible))
        (tmp_path / "tokens.json.tmp").write_text(
            json.dumps({"username": "rescapé"}), encoding="utf-8")

        assert bridge.load_tokens()["username"] == "rescapé"

    def test_json_corrompu_ne_leve_pas(self, bridge, tmp_path, monkeypatch):
        cible = tmp_path / "tokens.json"
        monkeypatch.setattr(bridge, "TOKEN_FILE", str(cible))
        cible.write_text("{ ceci n'est pas du JSON", encoding="utf-8")
        assert bridge.load_tokens() is None

    def test_uuid_appareil_stable(self, bridge, tmp_path, monkeypatch):
        """Pronote invalide le jeton si l'UUID d'appareil change."""
        monkeypatch.setattr(bridge, "CACHE_DIR", str(tmp_path))
        monkeypatch.setattr(bridge, "UUID_FILE", str(tmp_path / "device_uuid.txt"))
        premier = bridge.get_device_uuid()
        assert premier.startswith("mmm-pronotepy-")
        assert bridge.get_device_uuid() == premier


# ─────────────────────────────────────────────────────────────────────────────
# Persistance du jeton apres promotion du secours
# ─────────────────────────────────────────────────────────────────────────────

class TestPersistanceApresPromotion:
    """La panne du 2026-09-08 : « ca marche, puis c est mort 8 minutes apres ».

    Le repli sur l appareil de secours ecrivait `tokens["backup"] = None`.
    Le crochet de persistance faisait ensuite `store.get("backup", {})`, qui
    rend la VALEUR quand la cle existe — donc None, pas le defaut. Le .get()
    suivant levait un AttributeError, avale par un `except Exception` et
    trace en debug seulement. Plus aucun jeton n etait persiste, et comme
    PRONOTE ne retient que le dernier emis, le compte mourait au cycle
    suivant.
    """

    def test_get_avec_defaut_ne_protege_pas_de_none(self):
        """Le piege Python a l origine de la panne, isole."""
        store = {"backup": None}
        with pytest.raises(AttributeError):
            store.get("backup", {}).get("uuid")
        assert (store.get("backup") or {}).get("uuid") is None

    def test_promotion_retire_la_cle_au_lieu_d_y_ecrire_none(self, bridge, tmp_path, monkeypatch):
        """Ne pas laisser le piege en place pour le prochain lecteur."""
        cible = tmp_path / "tokens.json"
        monkeypatch.setattr(bridge, "TOKEN_FILE", str(cible))

        tokens = {"primary": {"token": "mort"}, "backup": {"token": "secours", "uuid": "u2"}}
        tokens["primary"] = tokens.get("backup")
        tokens.pop("backup", None)
        bridge.save_tokens(tokens)

        relu = bridge.load_tokens()
        assert relu["primary"]["token"] == "secours"
        assert "backup" not in relu

    def test_le_crochet_persiste_meme_sans_secours(self, bridge, tmp_path, monkeypatch):
        """Le coeur de la regression : sans secours, la persistance doit
        continuer de fonctionner — c est elle qui garde le compte en vie."""
        import pronotepy.clients as clients

        cible = tmp_path / "tokens.json"
        monkeypatch.setattr(bridge, "TOKEN_FILE", str(cible))
        monkeypatch.setattr(bridge, "_persist_hook_installed", False)
        monkeypatch.setattr(clients.ClientBase, "_login", lambda self: True)

        # Etat laisse par une promotion de l ancienne version : backup a None.
        bridge.save_tokens({"primary": {"token": "ancien", "uuid": "u1"},
                            "backup": None})

        bridge.install_token_persistence()

        class FauxClient(clients.ClientBase):
            login_mode = "token"

            def export_credentials(self):
                return {"pronote_url": "https://x/pronote", "username": "parent",
                        "password": "JETON-RENOUVELE", "client_identifier": "ci",
                        "uuid": "u1"}

        assert clients.ClientBase._login(FauxClient()) is True

        relu = bridge.load_tokens()
        assert relu["primary"]["token"] == "JETON-RENOUVELE",             "le jeton renouvele doit etre persiste, sinon le compte meurt au cycle suivant"
        assert relu["username"] == "parent"

    def test_le_crochet_ecrit_dans_le_bon_emplacement(self, bridge, tmp_path, monkeypatch):
        """Quand l uuid correspond au secours, c est lui qu on met a jour :
        ecraser le principal ferait perdre la reserve."""
        import pronotepy.clients as clients

        monkeypatch.setattr(bridge, "TOKEN_FILE", str(tmp_path / "tokens.json"))
        monkeypatch.setattr(bridge, "_persist_hook_installed", False)
        monkeypatch.setattr(clients.ClientBase, "_login", lambda self: True)

        bridge.save_tokens({"primary": {"token": "p", "uuid": "u1"},
                            "backup": {"token": "b", "uuid": "u2"}})
        bridge.install_token_persistence()

        class FauxSecours(clients.ClientBase):
            login_mode = "token"

            def export_credentials(self):
                return {"pronote_url": "u", "username": "parent", "password": "NEUF",
                        "client_identifier": "ci", "uuid": "u2"}

        clients.ClientBase._login(FauxSecours())

        relu = bridge.load_tokens()
        assert relu["backup"]["token"] == "NEUF"
        assert relu["primary"]["token"] == "p"

    def test_un_echec_de_persistance_est_annonce(self, bridge, capsys, monkeypatch):
        """Trace en debug seulement, l echec restait invisible jusqu a la
        panne. Le prefixe le fait remonter en avertissement cote Node."""
        import pronotepy.clients as clients

        monkeypatch.setattr(bridge, "_persist_hook_installed", False)
        monkeypatch.setattr(clients.ClientBase, "_login", lambda self: True)
        monkeypatch.setattr(bridge, "load_tokens",
                            lambda: (_ for _ in ()).throw(OSError("disque plein")))
        bridge.install_token_persistence()

        class FauxClient(clients.ClientBase):
            login_mode = "token"

        assert clients.ClientBase._login(FauxClient()) is True   # jamais interrompu
        assert bridge.WARN_PREFIX in capsys.readouterr().err


# ─────────────────────────────────────────────────────────────────────────────
# Protocole stdin/stdout
# ─────────────────────────────────────────────────────────────────────────────

class TestMain:
    def _lancer(self, bridge, entree, capsys, monkeypatch):
        monkeypatch.setattr(sys, "stdin", _Entree(entree))
        bridge.main()
        return json.loads(capsys.readouterr().out)

    def test_action_inconnue(self, bridge, capsys, monkeypatch):
        sortie = self._lancer(bridge, '{"action": "danser"}', capsys, monkeypatch)
        assert sortie["ok"] is False
        assert sortie["kind"] == "error"
        assert "danser" in sortie["error"]

    def test_commande_illisible(self, bridge, capsys, monkeypatch):
        sortie = self._lancer(bridge, "{pas du json", capsys, monkeypatch)
        assert sortie["ok"] is False
        assert "illisible" in sortie["error"]

    def test_bom_utf8_tolere(self, bridge, capsys, monkeypatch):
        """Certains appelants préfixent un BOM ; json.loads le refuserait."""
        sortie = self._lancer(bridge, "﻿{\"action\": \"inconnue\"}", capsys, monkeypatch)
        assert sortie["kind"] == "error"

    def test_exception_metier_classee(self, bridge, capsys, monkeypatch):
        """Une erreur remontée par une action ressort avec son « kind » :
        c'est lui qui décide du message affiché à l'écran du miroir."""
        monkeypatch.setitem(bridge.ACTIONS, "fetch",
                            lambda payload: (_ for _ in ()).throw(bridge.NoTokens("rien")))
        sortie = self._lancer(bridge, '{"action": "fetch"}', capsys, monkeypatch)
        assert sortie == {"ok": False, "kind": "no_tokens", "error": "rien"}

    def test_succes(self, bridge, capsys, monkeypatch):
        monkeypatch.setitem(bridge.ACTIONS, "fetch", lambda payload: {"name": "Hugo"})
        sortie = self._lancer(bridge, '{"action": "fetch"}', capsys, monkeypatch)
        assert sortie == {"ok": True, "data": {"name": "Hugo"}}

    def test_dates_serialisees_par_defaut(self, bridge, capsys, monkeypatch):
        """`default=str` évite qu'un objet date oublié fasse échouer tout le
        cycle sur « not JSON serializable »."""
        monkeypatch.setitem(bridge.ACTIONS, "fetch",
                            lambda payload: {"jour": dt.date(2026, 9, 5)})
        sortie = self._lancer(bridge, '{"action": "fetch"}', capsys, monkeypatch)
        assert sortie["data"]["jour"] == "2026-09-05"


class _Entree(object):
    """stdin minimal : `main()` n'en lit que `read()`."""

    def __init__(self, contenu):
        self._contenu = contenu

    def read(self):
        return self._contenu


# ─────────────────────────────────────────────────────────────────────────────
# Contrat entre le pont et Node
# ─────────────────────────────────────────────────────────────────────────────

def test_le_prefixe_d_avertissement_est_le_meme_des_deux_cotes(bridge):
    """Le pont marque d un prefixe les traces qui doivent rester visibles
    sans « debug: true » ; node_helper.js les reconnait a ce prefixe. Deux
    constantes dans deux langages : si elles divergent, les avertissements
    redeviennent silencieux — exactement la panne qu ils servent a eviter."""
    import io as _io
    import os as _os
    import re as _re

    chemin = _os.path.join(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))),
                           "node_helper.js")
    source = _io.open(chemin, encoding="utf-8").read()
    trouve = _re.search(r"BRIDGE_WARN_PREFIX\s*=\s*'([^']+)'", source)

    assert trouve, "BRIDGE_WARN_PREFIX introuvable dans node_helper.js"
    assert trouve.group(1) == bridge.WARN_PREFIX
