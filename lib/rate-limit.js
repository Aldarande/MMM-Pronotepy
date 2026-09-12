'use strict';
/* MMM-Pronotepy — module MagicMirror² pour Pronote
 * Copyright (C) 2024-2026 Aldarande
 * Licensed under the MIT License. See LICENSE for details.
 */

/* =====================================================================
   MMM-Pronotepy — lib/rate-limit.js
   Garde-fous contre une suspension d'adresse IP par PRONOTE.

   LE RISQUE, constaté en production sur le plugin ProJote (même auteur) :
   PRONOTE suspend l'adresse IP au-delà d'un certain rythme
   d'authentifications, et répond alors « Your IP address is suspended. »
   à tout le foyer. Chaque connexion compte — le jeton est renouvelé à
   chaque fois, ce n'est pas une session réutilisée.

   CE QUI PEUT S'EMBALLER, indépendamment de `updateInterval` :

     • Le rechargement de la page du miroir. MagicMirror émet
       ALL_MODULES_STARTED à chaque connexion d'un client, le frontend
       renvoie SET_CONFIG, et le backend relançait une collecte immédiate.
       Vingt rafraîchissements = vingt authentifications.
     • Le redémarrage en boucle. Une erreur de syntaxe dans config.js fait
       redémarrer MagicMirror toutes les 60 s ; chaque démarrage
       déclenchait sa collecte.
     • Un `updateInterval` très court, saisi par erreur.
     • Un échec persistant : réessayer au même rythme un serveur qui
       refuse, c'est prolonger le refus.

   C'est pourquoi l'état est PERSISTÉ : un compteur qui vit en mémoire ne
   protège de rien face à un redémarrage en boucle, qui est justement le
   scénario le plus dangereux.

   L'état est tenu PAR COMPTE, pas par instance : c'est le compte que
   PRONOTE voit. Deux instances qui partagent un compte parent doivent
   partager le même budget.

   Toute la décision est dans `evaluate()`, une fonction pure.
   ===================================================================== */

const fs   = require('fs');
const path = require('path');

const MINUTE = 60000;
const HEURE  = 60 * MINUTE;

const DEFAULTS = {
  /* Plancher absolu entre deux tentatives, quelle que soit leur origine.
   * Cinq minutes laissent passer une reconfiguration volontaire sans
   * gêner, et écrasent les rafales de rechargement de page. */
  minIntervalMs: 5 * MINUTE,

  /* Après un échec, on attend de plus en plus longtemps : 5, 10, 20, 40
   * minutes… Réessayer au même rythme un serveur qui refuse ne le fera
   * pas changer d'avis, et alimente le compteur qui mène à la
   * suspension. */
  backoffBaseMs: 5 * MINUTE,
  backoffMaxMs:  6 * HEURE,

  /* PRONOTE a annoncé une suspension : on se tait longtemps. C'est le
   * seul cas où insister aggrave objectivement la situation. */
  suspensionCooldownMs: 6 * HEURE,

  /* Filet de dernier recours, par compte et par jour. Ne devrait jamais
   * être atteint avec les règles ci-dessus ; s'il l'est, c'est qu'un
   * chemin nous a échappé, et mieux vaut s'arrêter que découvrir le
   * problème par une suspension. */
  dailyMaxAttempts: 60
};

/** État neuf. */
function emptyState () {
  return {
    lastAttempt:         0,
    consecutiveFailures: 0,
    suspendedUntil:      0,
    day:                 '',
    attemptsToday:       0
  };
}

/* Jour civil local : le plafond quotidien doit se réinitialiser à minuit
 * chez l'utilisateur, pas à minuit UTC. */
function dayKey (now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-` +
         `${String(d.getDate()).padStart(2, '0')}`;
}

function withDefaults (options) {
  return Object.assign({}, DEFAULTS, options || {});
}

/* Recul courant, borné. `consecutiveFailures` = 1 → base, 2 → 2×base… */
function backoffMs (echecs, opts) {
  if (echecs <= 0) return 0;
  const brut = opts.backoffBaseMs * Math.pow(2, echecs - 1);
  return Math.min(brut, opts.backoffMaxMs);
}

/**
 * Peut-on tenter une collecte ?  Fonction pure.
 *
 * @returns {{allowed: boolean, reason: string, retryAfterMs: number,
 *            message: string|null}}
 *   `reason` ∈ 'ok' | 'suspended' | 'daily-cap' | 'backoff' | 'min-interval'
 *
 * L'ordre des règles n'est pas indifférent : la suspension prime sur
 * tout, puis le plafond quotidien, puis le recul après échec, et enfin le
 * plancher. C'est l'ordre du plus grave au plus anodin — `reason` sert à
 * expliquer le blocage dans les logs, autant nommer la vraie cause.
 */
function evaluate (state, options, now) {
  const s    = Object.assign(emptyState(), state || {});
  const opts = withDefaults(options);
  const t    = now === undefined ? Date.now() : now;

  if (s.suspendedUntil > t) {
    return {
      allowed: false, reason: 'suspended', retryAfterMs: s.suspendedUntil - t,
      message: 'PRONOTE a signalé une suspension d\'adresse IP. Toute tentative ' +
               'la prolongerait : les collectes sont gelées pendant ' +
               humanize(s.suspendedUntil - t) + '.'
    };
  }

  /* Le compteur du jour ne vaut que pour le jour où il a été écrit. */
  const memeJour = s.day === dayKey(t);
  if (memeJour && s.attemptsToday >= opts.dailyMaxAttempts) {
    const minuit = new Date(t);
    minuit.setHours(24, 0, 0, 0);
    return {
      allowed: false, reason: 'daily-cap', retryAfterMs: minuit.getTime() - t,
      message: `Plafond de ${opts.dailyMaxAttempts} authentifications atteint pour ` +
               'aujourd\'hui. Ce plafond est un filet de sécurité : l\'atteindre ' +
               'signale un cycle anormal, pas un usage normal.'
    };
  }

  if (s.consecutiveFailures > 0) {
    const attendre = backoffMs(s.consecutiveFailures, opts);
    const restant  = s.lastAttempt + attendre - t;
    if (restant > 0) {
      return {
        allowed: false, reason: 'backoff', retryAfterMs: restant,
        message: `${s.consecutiveFailures} échec(s) de suite — prochaine tentative ` +
                 `dans ${humanize(restant)}.`
      };
    }
  }

  const depuis = t - s.lastAttempt;
  if (s.lastAttempt > 0 && depuis < opts.minIntervalMs) {
    return {
      allowed: false, reason: 'min-interval', retryAfterMs: opts.minIntervalMs - depuis,
      message: `Collecte demandée ${humanize(depuis)} après la précédente — ignorée. ` +
               'Le plancher évite qu\'un rechargement de page ou un redémarrage ' +
               'en boucle ne multiplie les authentifications.'
    };
  }

  return { allowed: true, reason: 'ok', retryAfterMs: 0, message: null };
}

/** État après une tentative. Pure : rend un nouvel objet. */
function afterAttempt (state, now) {
  const s = Object.assign(emptyState(), state || {});
  const t = now === undefined ? Date.now() : now;
  const jour = dayKey(t);

  return Object.assign(s, {
    lastAttempt:   t,
    day:           jour,
    attemptsToday: (s.day === jour ? s.attemptsToday : 0) + 1
  });
}

/**
 * État après le résultat d'une tentative. Pure.
 * @param {{ok: boolean, kind?: string}} outcome
 */
function afterOutcome (state, now, outcome, options) {
  const s    = Object.assign(emptyState(), state || {});
  const t    = now === undefined ? Date.now() : now;
  const r    = outcome || {};
  const opts = withDefaults(options);

  if (r.ok) {
    /* Un succès efface tout : le recul comme la suspension. Si PRONOTE
     * répond de nouveau, c'est que la sanction est levée. */
    return Object.assign(s, { consecutiveFailures: 0, suspendedUntil: 0 });
  }

  return Object.assign(s, {
    consecutiveFailures: s.consecutiveFailures + 1,
    suspendedUntil: r.kind === 'ip_suspended'
      ? t + opts.suspensionCooldownMs
      : s.suspendedUntil
  });
}

/** « 2 h 15 », « 7 min », « 45 s » — pour les messages. */
function humanize (ms) {
  const secondes = Math.max(0, Math.round(ms / 1000));
  if (secondes < 90) return `${secondes} s`;
  const minutes = Math.round(secondes / 60);
  if (minutes < 90) return `${minutes} min`;
  const heures = Math.floor(minutes / 60);
  const reste  = minutes % 60;
  return reste ? `${heures} h ${String(reste).padStart(2, '0')}` : `${heures} h`;
}

/* ── Persistance ──────────────────────────────────────────────────────
 * Indispensable : un compteur en mémoire ne survit pas à un redémarrage,
 * or le redémarrage en boucle est précisément le scénario contre lequel
 * ce fichier existe.
 *
 * Le fichier ne contient aucune donnée scolaire — des horodatages et des
 * compteurs — d'où l'absence de 0600 ici. */
function stateFile (cacheDir, account) {
  const cle = String(account || 'default').replace(/[^a-z0-9-]/gi, '').toLowerCase() || 'default';
  return path.join(cacheDir, `rate-${cle}.json`);
}

function load (cacheDir, account) {
  try {
    const lu = JSON.parse(fs.readFileSync(stateFile(cacheDir, account), 'utf8'));
    return (lu && typeof lu === 'object') ? Object.assign(emptyState(), lu) : emptyState();
  } catch {
    return emptyState();
  }
}

function save (cacheDir, account, state) {
  const fichier = stateFile(cacheDir, account);
  const tmp     = `${fichier}.tmp`;
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, fichier);
    return true;
  } catch {
    /* Ne jamais faire échouer une collecte parce que le compteur n'a pas
     * pu être écrit — mais l'appelant doit le savoir : sans persistance,
     * le garde-fou ne protège plus du redémarrage en boucle. */
    try { fs.unlinkSync(tmp); } catch { /* rien à nettoyer */ }
    return false;
  }
}

module.exports = {
  evaluate, afterAttempt, afterOutcome, emptyState, dayKey, backoffMs, humanize,
  load, save, stateFile,
  DEFAULTS, MINUTE, HEURE
};
