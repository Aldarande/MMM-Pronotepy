'use strict';
/* MMM-Pronotepy — module MagicMirror² pour Pronote
 * Copyright (C) 2024-2026 Aldarande
 * Licensed under the MIT License. See LICENSE for details.
 */

/* =====================================================================
   MMM-Pronotepy — lib/quiet-hours.js
   Fenêtre de nuit : on cesse d'interroger Pronote.

   Trois bénéfices, tous mesurables :

     • PRONOTE — un tiers des authentifications en moins. C'est leur
       accumulation qui a valu une suspension d'adresse IP au plugin
       ProJote ; chaque cycle évité est un risque en moins.
     • CARTE SD — autant d'écritures de jeton en moins, chacune fsync'ée.
     • RIEN À GAGNER — un emploi du temps ne change pas à 3 h du matin.

   Ce n'est PAS un réglage d'affichage : `showFrom` / `showUntil` masquent
   des sections à l'écran, et sont indépendants. Ici, seule la collecte
   s'arrête ; ce qui est affiché le reste.

   La fenêtre franchit minuit dans le cas normal (20:00 → 07:00), ce qui
   inverse la comparaison. C'est précisément le genre de logique qui se
   casse sans bruit — d'où ce fichier séparé, et ses tests.
   ===================================================================== */

/* Bornes par défaut : après 20 h l'emploi du temps du lendemain est
 * publié depuis longtemps, et avant 7 h personne ne regarde encore. */
const DEFAULT_FROM  = '20:00';
const DEFAULT_UNTIL = '07:00';

/**
 * « 20:00 » → 1200 (minutes depuis minuit). null si illisible.
 * On accepte « 7:00 » comme « 07:00 » : config.js est écrit à la main.
 */
function parseTimeOfDay (value) {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{1,2})\s*[:h]\s*(\d{2})$/);
  if (!m) return null;

  const heures  = parseInt(m[1], 10);
  const minutes = parseInt(m[2], 10);
  if (heures > 23 || minutes > 59) return null;
  return heures * 60 + minutes;
}

/**
 * Décrit la fenêtre configurée, sans dépendre de l'heure qu'il est.
 *
 * @returns {{active: boolean, from: number|null, until: number|null,
 *            reason: string, message: string|null}}
 *
 * `reason` vaut 'ok', 'disabled', 'invalid' ou 'empty'.
 *
 * En cas de doute on DÉSACTIVE la pause plutôt que de l'appliquer : une
 * fenêtre mal comprise qui suspendrait les mises à jour laisserait un
 * miroir figé sans que rien ne l'explique. Se tromper dans ce sens-là
 * coûte quelques requêtes ; dans l'autre, il coûte la fonction entière.
 */
function describeWindow (config) {
  const cfg = config === undefined ? {} : config;

  if (cfg === null || cfg === false) {
    return { active: false, from: null, until: null, reason: 'disabled', message: null };
  }
  if (typeof cfg !== 'object') {
    return {
      active: false, from: null, until: null, reason: 'invalid',
      message: 'quietHours doit être un objet { from, until } ou null — réglage ignoré.'
    };
  }
  if (cfg.enabled === false) {
    return { active: false, from: null, until: null, reason: 'disabled', message: null };
  }

  const from  = parseTimeOfDay(cfg.from  === undefined ? DEFAULT_FROM  : cfg.from);
  const until = parseTimeOfDay(cfg.until === undefined ? DEFAULT_UNTIL : cfg.until);

  if (from === null || until === null) {
    return {
      active: false, from: null, until: null, reason: 'invalid',
      message: `quietHours : horaire illisible (from: ${JSON.stringify(cfg.from)}, ` +
               `until: ${JSON.stringify(cfg.until)}). Attendu « HH:MM ». ` +
               'La pause de nuit est désactivée.'
    };
  }

  /* Bornes identiques : « toute la journée » ou « jamais » ? Les deux se
   * défendent, donc aucune n'est évidente — on ne devine pas, et on ne
   * met surtout pas un miroir en pause permanente sur une ambiguïté. */
  if (from === until) {
    return {
      active: false, from, until, reason: 'empty',
      message: `quietHours : from et until sont identiques (${cfg.from}). ` +
               'Fenêtre ambiguë — la pause de nuit est désactivée.'
    };
  }

  return { active: true, from, until, reason: 'ok', message: null };
}

/**
 * Sommes-nous dans la fenêtre de nuit ?
 *
 * @param {object} config  le réglage `quietHours`
 * @param {Date|number} [now]
 */
function isQuiet (config, now) {
  const fenetre = describeWindow(config);
  if (!fenetre.active) return false;

  const date = now === undefined ? new Date() : new Date(now);
  if (isNaN(date.getTime())) return false;
  const minute = date.getHours() * 60 + date.getMinutes();

  /* Le cas normal franchit minuit (20:00 → 07:00) : la fenêtre est alors
   * l'UNION de deux intervalles, pas leur intersection. Écrire
   * `from <= t && t < until` donnerait ici un ensemble vide — et une
   * pause qui ne se déclenche jamais, sans le moindre message. */
  if (fenetre.from > fenetre.until) {
    return minute >= fenetre.from || minute < fenetre.until;
  }
  return minute >= fenetre.from && minute < fenetre.until;
}

/** Libellé pour le log de démarrage, ou null si la pause est inactive. */
function describe (config) {
  const fenetre = describeWindow(config);
  if (!fenetre.active) return null;
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:` +
                      `${String(m % 60).padStart(2, '0')}`;
  return `${hhmm(fenetre.from)} → ${hhmm(fenetre.until)}`;
}

module.exports = {
  parseTimeOfDay, describeWindow, isQuiet, describe,
  DEFAULT_FROM, DEFAULT_UNTIL
};
