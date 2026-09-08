'use strict';
/* MMM-Pronotepy — module MagicMirror² pour Pronote
 * Copyright (C) 2024-2026 Aldarande
 * Licensed under the MIT License. See LICENSE for details.
 */

/* =====================================================================
   FICHIER PARTAGÉ — COPIE CANONIQUE

   Ce fichier est volontairement INDÉPENDANT du module qui l'héberge : le
   nom du module et la provenance du secret sont injectés par l'appelant
   (`createApiAuth({ moduleName, getSecret, log })`). Il doit donc pouvoir
   être copié tel quel — octet pour octet — dans tout module MagicMirror²
   exposant des routes Express.

   Origine : le défaut « routes API sans authentification », relevé en
   F-005 de MMM/modules/SECURITY-AUDIT.md (2026-05-15) sur MMM-Pawmote,
   a été recopié à l'identique dans MMM-Pronotepy quatre mois plus tard.
   Ce fichier existe pour qu'il n'y ait pas de troisième fois.

   Copies connues :
     • MMM-Pronotepy/lib/api-auth.js   (référence)
     • MMM-Pawmote/lib/api-auth.js     (à synchroniser — cf. README)

   Vérifier que deux copies n'ont pas divergé, depuis MMM/modules :
     sha256sum MMM-Pronotepy/lib/api-auth.js MMM-Pawmote/lib/api-auth.js
   Toute correction se fait ICI puis se recopie ; ne jamais patcher une
   copie seule.
   ===================================================================== */

const crypto = require('crypto');

/* Adresses de bouclage littérales. Le reste de 127.0.0.0/8 est traité par
 * la regex plus bas (127.0.1.1 est le loopback par défaut de Debian). */
const LOOPBACK_EXACT = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/* Anti-force-brute : au-delà de ce nombre d'échecs consécutifs, l'adresse
 * est refusée en bloc pendant la fenêtre, sans même comparer le secret.
 * Un secret court reste devinable sur un LAN à plusieurs milliers de
 * requêtes par seconde ; ce garde-fou ramène le coût à quelques essais
 * par minute. */
const MAX_FAILURES   = 10;
const LOCKOUT_MS     = 60000;
const FAILURE_TTL_MS = 10 * 60000;

/* Longueur minimale acceptée pour un secret. En dessous, on considère
 * qu'il n'y a PAS de secret : mieux vaut le repli loopback-only, qui est
 * réellement fermé, qu'un mot de passe à trois lettres qui donne
 * l'illusion d'une protection ouverte sur tout le réseau. */
const MIN_SECRET_LENGTH = 12;

/* ── Ouverture explicite ──────────────────────────────────────────────
 * Sans clé, les routes ne répondent qu'en local. C'est sûr, mais cela
 * rend la page de configuration inatteignable depuis un téléphone — son
 * usage même. Ce réglage lève la restriction.
 *
 * Il est délibérément séparé de « pas de clé » : l'absence de secret est
 * le plus souvent un oubli, alors qu'écrire `allowUnauthenticated: true`
 * est une décision. Le défaut reste donc fermé, et l'ouverture se
 * déclare. On accepte les formes textuelles parce que la valeur peut
 * arriver d'une variable d'environnement, où tout est chaîne. */
function _estAutorisation (valeur) {
  if (valeur === true) return true;
  if (typeof valeur !== 'string') return false;
  return ['1', 'true', 'oui', 'yes', 'on'].includes(valeur.trim().toLowerCase());
}

/* ── Comparaison à temps constant ─────────────────────────────────────
 * `crypto.timingSafeEqual` exige deux buffers de même longueur — il lève
 * sinon, ce qui divulguerait la longueur du secret. On compare donc les
 * empreintes SHA-256, toujours longues de 32 octets. */
function safeEqual (a, b) {
  const ha = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/* ── Adresse de l'appelant ────────────────────────────────────────────
 * On lit délibérément `req.socket.remoteAddress` et NON `req.ip` : ce
 * dernier suit le réglage « trust proxy » d'Express et peut alors être
 * dicté par un en-tête X-Forwarded-For — c'est-à-dire par l'attaquant.
 * La socket, elle, ne ment pas. */
function remoteAddress (req) {
  return (req && req.socket && req.socket.remoteAddress) ||
         (req && req.connection && req.connection.remoteAddress) || '';
}

function isLoopback (req) {
  const addr = remoteAddress(req);
  if (LOOPBACK_EXACT.has(addr)) return true;
  const v4 = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/* ── Secret présenté par le client ────────────────────────────────────
 * Trois canaux, par ordre de préférence :
 *   1. Authorization: Bearer <secret>   — appels programmatiques
 *   2. X-Api-Key: <secret>              — page de configuration (fetch)
 *   3. ?key=<secret>                    — premier chargement au navigateur,
 *      seul canal disponible quand l'utilisateur tape une URL à la main.
 *      La page l'efface aussitôt de la barre d'adresse (history.replaceState)
 *      pour qu'il ne traîne ni dans l'historique ni dans un Referer. */
function presentedSecret (req) {
  const headers = (req && req.headers) || {};

  const auth = headers.authorization || '';
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();

  if (typeof headers['x-api-key'] === 'string') return headers['x-api-key'];

  if (req && req.query && typeof req.query.key === 'string') return req.query.key;

  /* Repli quand le middleware tourne hors du parseur de requête d'Express. */
  const url = (req && (req.originalUrl || req.url)) || '';
  const at  = url.indexOf('?');
  if (at !== -1) {
    const found = new URLSearchParams(url.slice(at + 1)).get('key');
    if (found !== null) return found;
  }
  return null;
}

/* ── Suivi des échecs, par adresse ───────────────────────────────────── */
function createFailureTracker () {
  const byAddress = new Map();

  const prune = (now) => {
    for (const [addr, entry] of byAddress) {
      if (now - entry.last > FAILURE_TTL_MS) byAddress.delete(addr);
    }
  };

  return {
    lockedUntil (addr, now) {
      const entry = byAddress.get(addr);
      if (!entry || entry.count < MAX_FAILURES) return 0;
      const until = entry.last + LOCKOUT_MS;
      return until > now ? until : 0;
    },
    fail (addr, now) {
      const entry = byAddress.get(addr) || { count: 0, last: 0 };
      /* Le compteur repart de zéro une fois la fenêtre de blocage écoulée :
       * une erreur de frappe d'il y a une heure ne doit pas condamner
       * l'utilisateur légitime. */
      if (entry.count >= MAX_FAILURES && now - entry.last > LOCKOUT_MS) entry.count = 0;
      entry.count += 1;
      entry.last   = now;
      byAddress.set(addr, entry);
      if (byAddress.size > 256) prune(now);
    },
    succeed (addr) { byAddress.delete(addr); },
    /* Exposé pour les tests. */
    _size () { return byAddress.size; }
  };
}

/* ── Réponses de refus ────────────────────────────────────────────────
 * Le corps ne dit jamais si le secret était absent, faux, ou si c'est
 * l'adresse qui est refusée : la même réponse pour tout le monde. */
function wantsJson (req) {
  const url = (req && (req.originalUrl || req.url)) || '';
  if (url.includes('/api/')) return true;
  const accept = ((req && req.headers && req.headers.accept) || '').toLowerCase();
  return accept.includes('application/json') && !accept.includes('text/html');
}

function denyPage (moduleName) {
  return '<!doctype html>\n' +
    '<html lang="fr"><head><meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    '<title>' + moduleName + ' — accès refusé</title>\n' +
    '<style>\n' +
    ' body{font:16px/1.6 system-ui,sans-serif;background:#12141a;color:#e8eaf0;\n' +
    '      margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}\n' +
    ' main{max-width:34rem;padding:2rem}\n' +
    ' h1{font-size:1.3rem;margin:0 0 1rem}\n' +
    ' code{background:#1e222b;padding:.15em .4em;border-radius:4px;font-size:.9em}\n' +
    ' p{color:#aab0c0}\n' +
    '</style></head><body><main>\n' +
    '<h1>401 — accès refusé</h1>\n' +
    '<p>Cette page est réservée à la configuration de <strong>' + moduleName + '</strong>.</p>\n' +
    '<p>Ajoutez la clé d\'API à l\'URL :<br>\n' +
    '<code>/' + moduleName + '/config?key=VOTRE_CLE</code></p>\n' +
    '<p>La clé se règle dans <code>config/config.js</code>, champ <code>apiKey</code>\n' +
    'du module, ou via la variable d\'environnement dédiée. Sans clé configurée,\n' +
    'ces pages ne répondent qu\'en local (127.0.0.1) — sauf si vous déclarez\n' +
    '<code>allowUnauthenticated: true</code>, qui les ouvre à tout le réseau.</p>\n' +
    '</main></body></html>';
}

function deny (req, res, moduleName) {
  res.status(401);
  /* Indique la nature de l'authentification attendue sans révéler l'état
   * de la configuration. */
  if (typeof res.set === 'function') res.set('WWW-Authenticate', 'Bearer realm="' + moduleName + '"');
  if (wantsJson(req)) return res.json({ error: 'Non autorisé' });
  if (typeof res.type === 'function') res.type('html');
  return res.send(denyPage(moduleName));
}

/* ── Description du mode retenu (log de démarrage) ──────────────────
 * Trois modes, du plus fermé au plus ouvert : « secret », « loopback »
 * (le défaut) et « open ». Le second argument est facultatif : un
 * appelant qui ne connaît pas l'ouverture explicite obtient le
 * comportement d'origine. */
function describeMode (secret, allowUnauthenticated) {
  const value  = typeof secret === 'string' ? secret.trim() : '';
  const ouvert = _estAutorisation(allowUnauthenticated);

  if (value.length >= MIN_SECRET_LENGTH) {
    return {
      mode: 'secret',
      level: 'info',
      message: ouvert
        /* Réglages contradictoires : la protection l'emporte. Le dire,
         * sinon l'utilisateur croira l'accès ouvert et cherchera
         * longtemps pourquoi il reçoit des 401. */
        ? 'Routes HTTP protégées par clé d\'API. Le réglage ' +
          '« allowUnauthenticated » est IGNORÉ : une clé est configurée, elle reste exigée.'
        : 'Routes HTTP protégées par clé d\'API.'
    };
  }

  if (ouvert) {
    return {
      mode: 'open',
      level: 'warn',
      message: 'ACCÈS NON AUTHENTIFIÉ ACTIVÉ (« allowUnauthenticated ») — les routes HTTP ' +
               'répondent à toute machine du réseau, sans identification. Elles exposent ' +
               'l\'identifiant Pronote et les prénoms des enfants, et permettent de supprimer ' +
               'les jetons. À ne garder que sur un réseau de confiance ; sinon, renseignez ' +
               '« apiKey ».'
    };
  }

  if (value.length > 0) {
    return {
      mode: 'loopback',
      level: 'warn',
      message: 'Clé d\'API trop courte (' + value.length + ' caractères, ' + MIN_SECRET_LENGTH +
               ' minimum) — elle est IGNORÉE. Les routes HTTP ne répondent que depuis 127.0.0.1.'
    };
  }

  return {
    mode: 'loopback',
    level: 'warn',
    message: 'Aucune clé d\'API configurée — les routes HTTP ne répondent que depuis ' +
             '127.0.0.1. Depuis une autre machine du réseau, la page de configuration ' +
             'renverra 401. Renseignez « apiKey » dans config/config.js pour y accéder, ' +
             'ou « allowUnauthenticated: true » pour ouvrir sans clé.'
  };
}

/* ── Fabrique du middleware ───────────────────────────────────────────
 * `getSecret` est une FONCTION, appelée à chaque requête : le secret
 * arrive avec la configuration du module (SET_CONFIG), donc APRÈS
 * l'enregistrement des routes. Le lire tardivement évite de figer un
 * « pas de secret » au démarrage — et le repli loopback couvre la
 * fenêtre entre le démarrage et la première configuration. */
function createApiAuth (options) {
  const opts       = options || {};
  const moduleName = opts.moduleName || 'module';
  const getSecret  = typeof opts.getSecret === 'function' ? opts.getSecret : () => '';
  const getOpen    = typeof opts.getAllowUnauthenticated === 'function'
    ? opts.getAllowUnauthenticated : () => false;
  const now        = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const log        = opts.log || {};
  const tracker    = opts.tracker || createFailureTracker();

  const warn = (...a) => { if (typeof log.warn === 'function') log.warn(...a); };

  const middleware = (req, res, next) => {
    const addr  = remoteAddress(req) || 'inconnu';
    const stamp = now();

    if (tracker.lockedUntil(addr, stamp)) return deny(req, res, moduleName);

    let secret = '';
    try { secret = String(getSecret() || '').trim(); } catch { secret = ''; }

    /* Mode « secret » : la clé est exigée, y compris en local. Un secret
     * trop court est traité comme absent (cf. MIN_SECRET_LENGTH). Il est
     * évalué AVANT l'ouverture explicite : entre deux réglages
     * contradictoires, on retient le plus fermé. */
    if (secret.length >= MIN_SECRET_LENGTH) {
      const given = presentedSecret(req);
      if (given !== null && safeEqual(given, secret)) {
        tracker.succeed(addr);
        return next();
      }
      tracker.fail(addr, stamp);
      warn('Accès refusé (clé absente ou invalide) — ' + (req.method || '?') + ' ' +
           (req.originalUrl || req.url) + ' depuis ' + addr);
      return deny(req, res, moduleName);
    }

    /* Ouverture déclarée : aucune clé, mais l'utilisateur a demandé
     * explicitement que le réseau puisse entrer. On ne refuse rien, et
     * on ne journalise rien par requête — le sondage de la page de
     * configuration noierait les logs. L'avertissement de démarrage
     * suffit à rappeler dans quel mode tourne le module. */
    let ouvert = false;
    try { ouvert = _estAutorisation(getOpen()); } catch { ouvert = false; }
    if (ouvert) return next();

    /* Repli : aucune clé exploitable, aucune ouverture → local seulement. */
    if (isLoopback(req)) return next();

    tracker.fail(addr, stamp);
    warn('Accès refusé (aucune clé d\'API configurée, appel non local) — ' +
         (req.method || '?') + ' ' + (req.originalUrl || req.url) + ' depuis ' + addr);
    return deny(req, res, moduleName);
  };

  middleware.describeMode = () => describeMode(getSecret(), getOpen());
  return middleware;
}

module.exports = {
  createApiAuth,
  createFailureTracker,
  describeMode,
  /* Exportés pour les tests et pour un éventuel réemploi. */
  isLoopback,
  presentedSecret,
  safeEqual,
  MIN_SECRET_LENGTH,
  MAX_FAILURES,
  LOCKOUT_MS
};
