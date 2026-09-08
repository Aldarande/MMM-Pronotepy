'use strict';
/* MMM-Pronotepy — module MagicMirror² pour Pronote
 * Copyright (C) 2024-2026 Aldarande
 * Licensed under the MIT License. See LICENSE for details.
 */

/* =====================================================================
   MMM-Pronotepy — lib/offline-cache.js
   Dernière collecte réussie, conservée pour survivre à une coupure.

   Sans cela, la moindre panne réseau vide l'écran : le module bascule
   sur la page d'erreur et l'emploi du temps du matin disparaît alors
   qu'il était parfaitement valide dix minutes plus tôt.

   LE PIÈGE, et la raison de la règle du même jour :

     La charge utile est RELATIVE AU JOUR. « timetableToday » ne veut pas
     dire « ces cours-là », mais « les cours d'aujourd'hui ». Rejouer le
     cache de la veille afficherait donc l'emploi du temps d'hier comme
     étant celui du jour — un enfant partirait avec le mauvais cartable.
     Une donnée périmée est ici PIRE qu'une absence de donnée.

     Le cache ne franchit donc jamais minuit, quel que soit `maxAge`.
     Passé cette limite, on revient à l'écran d'erreur, qui a le mérite
     de ne rien affirmer de faux.

   Le fichier contient des notes, des absences et des punitions : il est
   écrit en 0600, comme le fichier de jetons.
   ===================================================================== */

const fs   = require('fs');
const path = require('path');

/* Six heures : de quoi couvrir une box en panne toute une matinée sans
 * jamais présenter des cours qui ne sont plus au programme du jour. */
const DEFAULT_MAX_AGE = '6h';

/* ── Durées ───────────────────────────────────────────────────────────
 * Distinct de parseInterval (lib/format.js), qui retombe sur 15 min pour
 * toute valeur incomprise : ici, une valeur vide ou nulle doit vouloir
 * dire « désactivé », pas « six heures ». */
function parseMaxAge (value) {
  if (value === null || value === undefined || value === false) return 0;
  const texte = String(value).trim().toLowerCase();
  if (!texte || texte === '0' || texte === 'false' || texte === 'off') return 0;

  const m = texte.match(/^(\d+)\s*([smhd])$/);
  if (!m) return 0;                       // valeur incomprise → désactivé
  const unites = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return parseInt(m[1], 10) * unites[m[2]];
}

/* ── Nom de fichier ───────────────────────────────────────────────────
 * Une instance par enfant : c'est le prénom qui détermine les données,
 * pas l'identifiant d'instance MagicMirror — celui-ci change dès qu'on
 * réordonne config.js, ce qui perdrait le cache sans raison.
 *
 * Le prénom vient de config.js, donc d'une source de confiance, mais il
 * finit dans un chemin : on n'en garde que des caractères inoffensifs
 * plutôt que de se fier à cette confiance. */
function cacheKey (childName) {
  const nettoye = String(childName || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return nettoye || 'defaut';
}

function cacheFile (dir, key) {
  return path.join(dir, `last-${cacheKey(key)}.json`);
}

/* ── Écriture ─────────────────────────────────────────────────────────
 * Atomique (tmp + rename) : une coupure de courant pendant l'écriture
 * laisserait sinon un JSON tronqué, et le cache serait perdu au moment
 * précis où il aurait servi.
 *
 * Au-delà de ce délai, on réécrit même si rien n'a changé, pour que
 * l'horodatage ne dérive pas : c'est lui qui décide si le cache est
 * encore présentable. Une heure borne les écritures à 24 par jour dans
 * le pire des cas, tout en gardant une fraîcheur exploitable. */
const REFRESH_AFTER_MS = 3600000;

/**
 * @returns {'written'|'unchanged'|'failed'}
 *   'unchanged' = rien n'a été écrit sur le disque.
 */
function save (dir, key, data, now, refreshAfterMs) {
  const fichier = cacheFile(dir, key);
  const tmp     = `${fichier}.tmp`;
  const instant = now === undefined ? Date.now() : now;
  const serialise = JSON.stringify(data);
  const contenu = JSON.stringify({
    collectedAt: new Date(instant).toISOString(),
    data
  });

  /* ── Économie d'écritures ───────────────────────────────────────────
   * MagicMirror tourne le plus souvent sur un Raspberry Pi, donc sur une
   * carte SD, dont l'endurance se compte en cycles d'effacement. Réécrire
   * quatre fois par heure une charge utile rigoureusement identique — ce
   * qui est le cas toutes les nuits, tous les week-ends et pendant les
   * vacances, soit la majorité de l'année — est de l'usure sans
   * contrepartie.
   *
   * Relire pour comparer ne coûte rien : la lecture n'use pas la carte. */
  const fraicheurMax = refreshAfterMs === undefined ? REFRESH_AFTER_MS : refreshAfterMs;
  const precedent = load(dir, key);
  if (precedent && JSON.stringify(precedent.data) === serialise) {
    const age = instant - new Date(precedent.collectedAt).getTime();
    if (age >= 0 && age < fraicheurMax) return 'unchanged';
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, contenu, { mode: 0o600 });
    /* writeFileSync n'applique `mode` qu'à la création : sur un fichier
     * déjà présent, les permissions d'origine seraient conservées. */
    try { fs.chmodSync(tmp, 0o600); } catch { /* systèmes sans POSIX */ }
    fs.renameSync(tmp, fichier);
    return 'written';
  } catch {
    /* Un cache qu'on n'arrive pas à écrire ne doit jamais faire échouer
     * une collecte par ailleurs réussie. */
    try { fs.unlinkSync(tmp); } catch { /* rien à nettoyer */ }
    return 'failed';
  }
}

/* ── Lecture ──────────────────────────────────────────────────────── */
function load (dir, key) {
  try {
    const brut = fs.readFileSync(cacheFile(dir, key), 'utf8');
    const lu   = JSON.parse(brut);
    if (!lu || typeof lu !== 'object' || !lu.data) return null;
    return lu;
  } catch {
    return null;                          // absent, illisible ou corrompu
  }
}

/* ── Le cache est-il présentable ? ────────────────────────────────────
 * Fonction pure — c'est ici que vit toute la décision, et donc ici
 * qu'elle est éprouvée.
 *
 * `reason` sert au log : « pourquoi l'écran est-il passé à l'erreur ? »
 * est exactement la question qu'on se pose un matin sans réseau. */
function evaluate (options) {
  const opts     = options || {};
  const entree   = opts.entry;
  const now      = opts.now === undefined ? Date.now() : opts.now;
  const maxAgeMs = opts.maxAgeMs === undefined ? parseMaxAge(DEFAULT_MAX_AGE) : opts.maxAgeMs;

  if (!maxAgeMs)            return { usable: false, reason: 'disabled', ageMs: null };
  if (!entree || !entree.data) return { usable: false, reason: 'no-cache', ageMs: null };

  const collecte = new Date(entree.collectedAt);
  if (isNaN(collecte.getTime())) return { usable: false, reason: 'invalid', ageMs: null };

  const maintenant = new Date(now);
  const ageMs      = maintenant.getTime() - collecte.getTime();

  /* Une horloge qui recule (NTP au démarrage d'un Raspberry Pi sans pile)
   * donnerait un âge négatif : on refuse plutôt que de faire confiance. */
  if (ageMs < 0) return { usable: false, reason: 'future', ageMs };

  /* La règle du jour est évaluée AVANT celle de l'âge — voir l'en-tête.
   * Les deux peuvent être vraies en même temps ; c'est celle-ci qui doit
   * nommer la cause, parce qu'elle est la plus actionnable : « le cache
   * date d'hier » se comprend, « il est vieux » n'explique rien. */
  if (collecte.getFullYear() !== maintenant.getFullYear()
      || collecte.getMonth() !== maintenant.getMonth()
      || collecte.getDate()  !== maintenant.getDate()) {
    return { usable: false, reason: 'other-day', ageMs };
  }

  if (ageMs > maxAgeMs) return { usable: false, reason: 'too-old', ageMs };

  return { usable: true, reason: 'ok', ageMs };
}

module.exports = {
  parseMaxAge, cacheKey, cacheFile, save, load, evaluate,
  DEFAULT_MAX_AGE, REFRESH_AFTER_MS
};
