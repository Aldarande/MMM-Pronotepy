'use strict';
/* MMM-Pronotepy — module MagicMirror² pour Pronote
 * Copyright (C) 2024-2026 Aldarande
 * Licensed under the MIT License. See LICENSE for details.
 */

/* =====================================================================
   MMM-Pronotepy — node_helper.js
   Backend MagicMirror² — orchestre le pont Python pronote_bridge.py

   Répartition des rôles :
     • Python (pronotepy) : accès Pronote, jetons, filtrage des données
     • Node               : routes Express, cycles d'instance, formatage
                            localisé des dates avant envoi au frontend

   Les traitements purs vivent dans lib/ pour être testables sans le
   runtime MagicMirror :
     • lib/api-auth.js        authentification des routes HTTP
     • lib/bridge-runner.js   lancement et surveillance du pont Python
     • lib/bridge-protocol.js décodage de la réponse du pont
     • lib/format.js          mise en forme localisée
     • lib/python.js          choix de l'interpréteur Python
     • lib/offline-cache.js   dernière collecte, pour survivre aux coupures
     • lib/quiet-hours.js     fenêtre de nuit, pour cesser d'interroger Pronote
     • lib/accounts.js        plusieurs comptes Pronote sur un même miroir
   ===================================================================== */

const NodeHelper = require('node_helper');
const path       = require('path');
const fs         = require('fs');

const { createApiAuth }                 = require('./lib/api-auth');
const { runBridge }                     = require('./lib/bridge-runner');
const { messageForKind }                = require('./lib/bridge-protocol');
const { localize, parseInterval }       = require('./lib/format');
const { resolvePython }                 = require('./lib/python');
const offlineCache                      = require('./lib/offline-cache');
const quietHours                        = require('./lib/quiet-hours');
const accounts                          = require('./lib/accounts');

const MODULE_NAME = 'MMM-Pronotepy';
const CACHE_DIR   = path.join(__dirname, 'cache');
const BRIDGE      = path.join(__dirname, 'pronote_bridge.py');
const VENV_DIR    = path.join(__dirname, '.venv');

/* Clé d'API hors config.js. MagicMirror sert config/config.js au
 * navigateur : une clé écrite là est lisible par quiconque peut charger
 * la page du miroir. Cette variable d'environnement, elle, ne quitte
 * jamais le processus Node — et elle est disponible dès le démarrage,
 * avant même la première configuration d'instance. */
const API_KEY_ENV = 'MMM_PRONOTEPY_API_KEY';

/* Interpréteur Python hors config.js. Même raison d'être que la variable
 * ci-dessus pour la clé : disponible dès le démarrage, et réglable au
 * niveau du conteneur — c'est là qu'on sait où Python a été installé. */
const PYTHON_ENV = 'MMM_PRONOTEPY_PYTHON';

/* Ouverture des routes sans clé. Séparé de l'absence de clé — qui est le
 * plus souvent un oubli — pour que l'ouverture soit toujours une
 * décision écrite quelque part. */
const ALLOW_OPEN_ENV = 'MMM_PRONOTEPY_ALLOW_UNAUTHENTICATED';

/* Doit rester identique à WARN_PREFIX dans pronote_bridge.py. */
const BRIDGE_WARN_PREFIX = 'WARN::';

/* ── Logging avec fichier:ligne ─────────────────────────────────── */
function _getCallerLoc(depth) {
  const err   = new Error();
  const stack = (err.stack || '').split('\n');
  for (let i = depth; i < Math.min(stack.length, depth + 6); i++) {
    const line = stack[i] || '';
    if (!line || line.includes('node:') || line.includes('node_modules') || line.includes('timers')) continue;
    const m = line.match(/\(([^)]+):(\d+):\d+\)/) || line.match(/at (?:\S+ )?\(?([^):\s]+\.js):(\d+):\d+\)?/);
    if (m) return `[${path.basename(m[1])}:${m[2]}] `;
  }
  return '';
}

/* Debug activé par instance (SET_CONFIG) — évite la contamination croisée */
const _debugInstances = new Set();

/* ── Buffer de logs circulaire (exposé via /api/logs) ──────────────── */
const _logBuffer = [];
function _addToBuffer (level, args) {
  const msg = args.map(a =>
    a === null ? 'null'
    : a === undefined ? 'undefined'
    : typeof a === 'object' ? (() => { try { return JSON.stringify(a); } catch { return String(a); } })()
    : String(a)
  ).join(' ');
  _logBuffer.push({ ts: Date.now(), level, msg });
  if (_logBuffer.length > 300) _logBuffer.shift();
}

const Log = {
  log:   (...a) => { if (_debugInstances.size > 0) { console.log(`[${MODULE_NAME}]`, ...a); _addToBuffer('log', a); } },
  info:  (...a) => { console.log(`[${MODULE_NAME}]`, ...a); _addToBuffer('info', a); },
  warn:  (...a) => { const loc = _getCallerLoc(3); console.warn(`[${MODULE_NAME}] ${loc}`, ...a); _addToBuffer('warn', [loc, ...a]); },
  error: (...a) => { const loc = _getCallerLoc(3); console.error(`[${MODULE_NAME}] ${loc}`, ...a); _addToBuffer('error', [loc, ...a]); }
};

/* ── Simple body-parser JSON (sans dépendance express) ──────────── */
function jsonBodyMiddleware(req, res, next) {
  /* MagicMirror peut déjà avoir un express.json() qui a consommé le body.
   * Dans ce cas req.body est déjà défini → on passe directement. */
  if (req.body !== undefined) return next();

  if (!(req.headers['content-type'] || '').includes('application/json')) {
    req.body = {};
    return next();
  }

  const MAX_BODY = 2 * 1024 * 1024; // 2 MB — protection DoS
  let body = '';
  req.on('data',  chunk => {
    body += chunk.toString();
    if (body.length > MAX_BODY) { req.destroy(); res.status(413).end('Payload too large'); }
  });
  req.on('end',   ()    => {
    try { req.body = JSON.parse(body); } catch { req.body = {}; }
    next();
  });
  req.on('error', ()    => { req.body = {}; next(); });
}

/* ======================================================================
   NODE HELPER
   ====================================================================== */
module.exports = NodeHelper.create({

  /* ── Initialisation ──────────────────────────────────────────────── */
  start () {
    this.instances   = new Map(); // instanceId → { config, timer, isConnecting }
    this.routesReady = false;
    this.pythonBin   = null;
    /* Clé d'API : d'abord l'environnement, puis la config du module —
     * cette dernière n'arrive qu'avec SET_CONFIG, donc après
     * l'enregistrement des routes. Le middleware la relit à chaque
     * requête (cf. lib/api-auth.js). */
    this.configuredApiKey     = '';
    this.configuredPythonPath = '';
    this.configuredAllowOpen  = false;
    this._authMode            = null;
    /* Mutex du pont : le script Python détient les jetons et les fait
     * tourner à chaque connexion. Deux instances (Hugo et Alice) qui
     * s'exécuteraient en parallèle brûleraient le même jeton primaire. */
    this._bridgeLock = Promise.resolve();
    Log.info('Node helper started');

    /* Reprise du fichier « tokens.json » des versions à compte unique.
     * Une seule fois, avant toute lecture : sans quoi une installation
     * existante réclamerait un rescan de QR Code pour une évolution qui
     * ne la concerne pas. */
    const reprise = accounts.migrateLegacy(CACHE_DIR);
    if (reprise.migrated) {
      Log.info(`Jetons repris : ${accounts.LEGACY_FILE} → compte « ${accounts.DEFAULT_ACCOUNT} ».`);
    } else if (reprise.reason === 'conflict') {
      Log.warn(`${accounts.LEGACY_FILE} et le compte « ${accounts.DEFAULT_ACCOUNT} » coexistent — `
             + 'aucun des deux n\'est touché. Supprimez celui qui ne sert plus.');
    } else if (reprise.reason === 'failed') {
      Log.warn(`Reprise de ${accounts.LEGACY_FILE} impossible : ${reprise.error}`);
    }

    this._setupRoutes();
  },

  /* ── Clé d'API ───────────────────────────────────────────────────── */
  _apiSecret () {
    return String(process.env[API_KEY_ENV] || this.configuredApiKey || '');
  },

  /* L'environnement l'emporte, comme pour la clé : c'est le réglage le
   * plus proche de l'exploitant de la machine. */
  _allowUnauthenticated () {
    const fromEnv = process.env[ALLOW_OPEN_ENV];
    if (fromEnv !== undefined && String(fromEnv).trim() !== '') return fromEnv;
    return this.configuredAllowOpen;
  },

  /* Trace le mode d'authentification effectif, une fois par changement :
   * au démarrage (aucune clé connue), puis éventuellement à l'arrivée de
   * la configuration si elle en apporte une. */
  _announceAuthMode () {
    if (!this._auth) return;
    const state = this._auth.describeMode();
    if (state.mode === this._authMode) return;
    this._authMode = state.mode;
    (state.level === 'warn' ? Log.warn : Log.info)(state.message);
  },

  /* ── Interpréteur Python ─────────────────────────────────────────── */
  /* Le choix lui-même vit dans lib/python.js ; ici on ne fait que le
   * mémoriser et le tracer une fois. Le cache est vidé si la config
   * apporte un autre chemin (cf. socketNotificationReceived). */
  _resolvePython () {
    if (this.pythonBin) return this.pythonBin;

    const chosen = resolvePython({
      fromEnv:    process.env[PYTHON_ENV],
      configured: this.configuredPythonPath,
      venvDir:    VENV_DIR
    });

    (chosen.level === 'warn' ? Log.warn : Log.info)(chosen.message);
    this.pythonBin = chosen.command;
    return this.pythonBin;
  },

  /* ── Appel du pont Python ────────────────────────────────────────── */
  _runBridge (payload) {
    return runBridge({
      python:  this._resolvePython(),
      script:  BRIDGE,
      cwd:     __dirname,
      payload,
      /* Les traces du pont ne s'affichent qu'avec « debug: true » — sauf
       * celles qu'il préfixe explicitement. Le pont s'en sert pour ce qui
       * annonce une panne à venir : un jeton non persisté, par exemple,
       * condamne le compte au cycle suivant et doit se voir sans avoir eu
       * la bonne idée d'activer le debug au préalable. */
      onLog: line => {
        const trace = line.trim();
        if (trace.startsWith(BRIDGE_WARN_PREFIX)) {
          Log.warn('py:', trace.slice(BRIDGE_WARN_PREFIX.length).trim());
        } else {
          Log.log('py:', line);
        }
      }
    });
  },

  /* Sérialise les appels au pont : un seul propriétaire des jetons. */
  _runBridgeExclusive (payload) {
    const previous = this._bridgeLock;
    let release;
    this._bridgeLock = new Promise(r => { release = r; });
    return previous
      .then(() => this._runBridge(payload))
      .finally(() => release());
  },

  /* ── Jetons (lecture seule — Python en est propriétaire) ─────────── */
  _loadTokens (account) {
    return accounts.loadTokens(CACHE_DIR, account);
  },

  /* Comptes connus : ceux déclarés par les instances, plus ceux déjà
   * présents sur le disque. La page de configuration s'en sert pour
   * proposer une liste plutôt que d'exiger qu'on retape l'étiquette. */
  _knownAccounts () {
    const vus = new Set(accounts.listStored(CACHE_DIR));
    for (const [, state] of this.instances) {
      vus.add(accounts.normalize(state.config && state.config.account));
    }
    if (vus.size === 0) vus.add(accounts.DEFAULT_ACCOUNT);
    return [...vus].sort();
  },

  /* ── Express — page de configuration ─────────────────────────────── */
  _setupRoutes () {
    if (this.routesReady) return;
    const app = this.expressApp;
    if (!app) {
      Log.warn('expressApp non disponible — nouvelle tentative dans 2s');
      setTimeout(() => this._setupRoutes(), 2000);
      return;
    }
    this.routesReady = true;

    /* ── Authentification ──────────────────────────────────────────
     * Monté AVANT toute route : `app.use` avec un préfixe couvre
     * /MMM-Pronotepy/* quelle que soit la route ajoutée ensuite, y
     * compris une future qu'on oublierait de protéger. C'est le
     * correctif du finding F-005 de MMM/modules/SECURITY-AUDIT.md,
     * hérité de MMM-Pawmote. */
    this._auth = createApiAuth({
      moduleName: MODULE_NAME,
      getSecret:  () => this._apiSecret(),
      getAllowUnauthenticated: () => this._allowUnauthenticated(),
      log:        Log
    });
    app.use(`/${MODULE_NAME}`, this._auth);

    Log.info('Routes Express enregistrées');
    this._announceAuthMode();

    /* Page HTML de configuration */
    app.get('/MMM-Pronotepy/config', (req, res) => {
      res.sendFile(path.join(__dirname, 'config-page', 'index.html'));
    });

    /* Page de documentation */
    app.get('/MMM-Pronotepy/docs', (req, res) => {
      res.sendFile(path.join(__dirname, 'config-page', 'docs.html'));
    });

    /* API — contenu brut du README (pour la page docs) */
    app.get('/MMM-Pronotepy/api/readme', (req, res) => {
      fs.readFile(path.join(__dirname, 'README.md'), 'utf8', (err, data) => {
        if (err) return res.status(500).send('README introuvable');
        res.type('text/plain; charset=utf-8').send(data);
      });
    });

    /* API — comptes connus du module */
    app.get('/MMM-Pronotepy/api/accounts', (req, res) => {
      res.json({ accounts: this._knownAccounts(), default: accounts.DEFAULT_ACCOUNT });
    });

    /* API — statut des jetons + état module, pour UN compte.
     * L'état « connecté » et l'erreur sont ceux des instances qui
     * utilisent ce compte : agréger toutes les instances afficherait
     * l'erreur d'un compte en face du statut d'un autre. */
    app.get('/MMM-Pronotepy/api/status', (req, res) => {
      const compte = accounts.normalize(req.query.account);
      const t = this._loadTokens(compte);

      let moduleError  = null;
      let anyConnected = false;
      for (const [, state] of this.instances) {
        if (accounts.normalize(state.config && state.config.account) !== compte) continue;
        if (state.lastError && !moduleError) moduleError = state.lastError;
        if (state.isConnected) anyConnected = true;
      }

      res.json({
        account:     compte,
        accounts:    this._knownAccounts(),
        hasTokens:   !!t,
        hasPrimary:  !!(t?.primary?.token),
        hasBackup:   !!(t?.backup?.token),
        url:         t?.pronote_url || '',
        username:    t?.username    || '',
        isParent:    t?.isParent    || false,
        childName:   t?.childName   || '',
        children:    t?.children    || [],
        moduleError,
        isConnected: anyConnected
      });
    });

    /* Après une configuration réussie : prévient les instances et relance */
    const afterSetup = (compte, result) => {
      /* Seules les instances de CE compte sont concernées : relancer les
       * autres brûlerait leurs jetons pour rien, et les ferait clignoter
       * sur l'écran de chargement sans raison. */
      const concernees = [...this.instances].filter(
        ([, state]) => accounts.normalize(state.config && state.config.account) === compte);

      for (const [id] of concernees) {
        this.sendSocketNotification('TOKEN_SAVED', { username: result.username, _instanceId: id });
      }
      setTimeout(() => { for (const [id] of concernees) this._connectAndFetch(id); }, 500);
    };

    /* API — connexion initiale QR Code */
    app.post('/MMM-Pronotepy/api/setup-qr', jsonBodyMiddleware, async (req, res) => {
      try {
        const { qrToken, pin, childName, accountPin } = req.body || {};
        if (!qrToken || !pin) return res.status(400).json({ error: 'qrToken et pin requis' });
        if (!/^\d{4}$/.test(String(pin))) return res.status(400).json({ error: 'PIN invalide (4 chiffres requis)' });

        const compte = accounts.normalize((req.body || {}).account);
        Log.info(`Setup QR Code — compte « ${compte} » — appel du pont pronotepy…`);
        const result = await this._runBridgeExclusive({
          action:  'setup_qr',
          account: compte,
          qr:      typeof qrToken === 'string' ? JSON.parse(qrToken) : qrToken,
          pin:     String(pin),
          childName,
          accountPin
        });

        Log.info(`Setup QR OK — ${result.username} (compte « ${compte} »)`);
        res.json({ ok: true, account: compte, ...result });
        afterSetup(compte, result);
      } catch (e) {
        Log.error('Setup QR :', e.message);
        res.status(500).json({ error: e.message });
      }
    });

    /* API — effacer les jetons */
    app.post('/MMM-Pronotepy/api/clear', jsonBodyMiddleware, (req, res) => {
      try {
        const compte = accounts.normalize((req.body || {}).account);
        const efface = accounts.removeTokens(CACHE_DIR, compte);
        Log.info(`Jetons du compte « ${compte} » ${efface ? 'supprimés' : 'déjà absents'}.`);
        res.json({ ok: true, account: compte, removed: efface });

        for (const [id, state] of this.instances) {
          if (accounts.normalize(state.config && state.config.account) !== compte) continue;
          this.sendSocketNotification('TOKEN_CLEARED', { _instanceId: id });
        }
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    /* API — buffer de logs (polling depuis la page de config) */
    app.get('/MMM-Pronotepy/api/logs', (req, res) => {
      const since = parseInt(req.query.since || '0', 10);
      const logs  = since ? _logBuffer.filter(l => l.ts > since) : _logBuffer.slice(-150);
      res.json({ logs, now: Date.now() });
    });
  },

  /* ── Connexion + collecte (par instance) ─────────────────────────── */
  async _connectAndFetch (instanceId) {
    const state = this.instances.get(instanceId);
    if (!state) return;
    if (state.isConnecting) { Log.log(`Instance ${instanceId} — collecte déjà en cours`); return; }
    state.isConnecting = true;

    const notify = (notif, payload) =>
      this.sendSocketNotification(notif, { ...payload, _instanceId: instanceId });

    try {
      const cfg    = state.config;
      const compte = accounts.normalize(cfg.account);
      Log.info(`Instance ${instanceId} — collecte (compte : ${compte}, `
             + `enfant : ${cfg.childName || 'auto'})…`);

      const raw = await this._runBridgeExclusive({
        action:    'fetch',
        account:   compte,
        childName: cfg.childName || '',
        config:    cfg
      });

      state.isConnected = true;
      state.lastError   = null;
      offlineCache.save(CACHE_DIR, accounts.offlineKey(compte, cfg.childName), raw);
      notify('PRONOTE_UPDATED', { ...localize(raw, cfg.language || 'fr-FR'), stale: null });

    } catch (e) {
      const kind = e.kind || 'error';
      Log.error(`Instance ${instanceId} — ${kind} :`, e.message);
      state.isConnected = false;
      state.lastError   = e.message;

      /* Plutôt que de vider l'écran, on rejoue la dernière collecte —
       * mais seulement tant qu'elle décrit encore le jour en cours (cf.
       * lib/offline-cache.js). Le bandeau porte l'heure de collecte et le
       * motif de l'échec : l'affichage reste utile sans jamais laisser
       * croire qu'il est à jour. */
      const cfg     = state.config;
      const entree  = offlineCache.load(
        CACHE_DIR, accounts.offlineKey(cfg.account, cfg.childName));
      const verdict = offlineCache.evaluate({
        entry:    entree,
        maxAgeMs: offlineCache.parseMaxAge(
          cfg.offlineMaxAge === undefined ? offlineCache.DEFAULT_MAX_AGE : cfg.offlineMaxAge)
      });

      if (verdict.usable) {
        const minutes = Math.round(verdict.ageMs / 60000);
        Log.warn(`Instance ${instanceId} — hors ligne : affichage de la collecte de `
               + `${new Date(entree.collectedAt).toLocaleTimeString(cfg.language || 'fr-FR')} `
               + `(${minutes} min).`);
        notify('PRONOTE_UPDATED', {
          ...localize(entree.data, cfg.language || 'fr-FR'),
          stale: {
            collectedAt: entree.collectedAt,
            ageMinutes:  minutes,
            reason:      messageForKind(kind, e)
          }
        });
      } else {
        Log.log(`Instance ${instanceId} — cache inutilisable (${verdict.reason})`);
        notify('ERROR', {
          type:      kind,
          message:   messageForKind(kind, e),
          configUrl: '/MMM-Pronotepy/config'
        });
      }
    } finally {
      state.isConnecting = false;
    }
  },

  /* ── Réception des notifications socket ─────────────────────────── */
  socketNotificationReceived (notification, payload) {
    switch (notification) {
      case 'SET_CONFIG': {
        const instanceId = payload._instanceId;
        if (!instanceId) break;
        if (payload.debug) _debugInstances.add(instanceId);
        else _debugInstances.delete(instanceId);
        if (typeof payload.apiKey === 'string') this.configuredApiKey = payload.apiKey;
        if (payload.allowUnauthenticated !== undefined && payload.allowUnauthenticated !== null) {
          this.configuredAllowOpen = payload.allowUnauthenticated;
        }
        this._announceAuthMode();

        /* Un changement d'interpréteur doit invalider le choix mémorisé,
         * sinon un « pythonPath » corrigé ne prendrait effet qu'au
         * prochain redémarrage de MagicMirror. */
        if (typeof payload.pythonPath === 'string'
            && payload.pythonPath !== this.configuredPythonPath) {
          this.configuredPythonPath = payload.pythonPath;
          this.pythonBin = null;
        }
        Log.info(`Instance ${instanceId} — config reçue (compte: `
               + `${accounts.normalize(payload.account)}, childName: ${payload.childName || 'auto'})`);
        this._startInstanceCycle(instanceId, payload);
        break;
      }
    }
  },

  /* ── Cycle de mise à jour par instance ──────────────────────────── */
  _startInstanceCycle (instanceId, config) {
    /* Arrête l'ancien timer si l'instance existait déjà */
    const existing = this.instances.get(instanceId);
    if (existing?.timer) clearInterval(existing.timer);

    const state = { config, timer: null, isConnecting: false, isConnected: false, lastError: null };
    this.instances.set(instanceId, state);

    this.sendSocketNotification('INITIALIZED', { _instanceId: instanceId });

    /* Cette première collecte ignore délibérément la fenêtre de nuit.
     * Un miroir redémarré à 23 h resterait sinon vide jusqu'au matin —
     * la pause vise le sondage périodique, pas le démarrage. Une seule
     * collecte au boot ne pèse rien. */
    this._connectAndFetch(instanceId);

    const fenetre = quietHours.describeWindow(config.quietHours);
    if (fenetre.message) Log.warn(fenetre.message);

    const interval = parseInterval(config.updateInterval);
    state.timer = setInterval(() => {
      if (quietHours.isQuiet(config.quietHours)) {
        /* Tracé une seule fois par nuit : à quatre réveils par heure,
         * une ligne par tick noierait le buffer de logs. */
        if (!state.quietLogged) {
          state.quietLogged = true;
          Log.info(`Instance ${instanceId} — pause de nuit (${quietHours.describe(config.quietHours)}) : `
                 + 'mises à jour suspendues.');
        }
        return;
      }
      if (state.quietLogged) {
        state.quietLogged = false;
        Log.info(`Instance ${instanceId} — fin de la pause de nuit, reprise des mises à jour.`);
      }
      this._connectAndFetch(instanceId);
    }, interval);

    const pause = quietHours.describe(config.quietHours);
    Log.info(`Instance ${instanceId} — mise à jour toutes les ${config.updateInterval || '60m'}`
           + (pause ? `, pause de nuit ${pause}` : ''));
  },

  /* Arrêt du miroir : les timers d'instance ne doivent pas survivre. */
  stop () {
    for (const [, state] of this.instances) {
      if (state.timer) clearInterval(state.timer);
    }
    this.instances.clear();
  }
});
