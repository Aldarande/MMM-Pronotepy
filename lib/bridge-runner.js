'use strict';
/* MMM-Pronotepy — module MagicMirror² pour Pronote
 * Copyright (C) 2024-2026 Aldarande
 * Licensed under the MIT License. See LICENSE for details.
 */

/* =====================================================================
   MMM-Pronotepy — lib/bridge-runner.js
   Lancement du pont Python, et tout ce qui peut mal s'y passer.

   Le pont est un processus court : une commande JSON sur stdin, une
   réponse JSON sur stdout, puis il meurt. Sauf quand il ne meurt pas —
   d'où ce fichier, qui borne les trois dérives possibles :

     • DURÉE   — un PRONOTE qui n'accuse jamais réception laisserait le
       processus vivant indéfiniment. Un cycle toutes les heures en
       accumulerait un par cycle. On envoie donc SIGTERM au délai imparti,
       puis SIGKILL si l'enfant n'est pas sorti dans la foulée, et on
       n'abandonne le suivi qu'une fois l'événement « close » reçu — c'est
       lui, et non le kill, qui garantit que le processus est récolté.

     • MÉMOIRE — stdout n'est pas borné par défaut. Un emploi du temps
       chargé fait quelques centaines de kilo-octets, mais un pont qui
       déraille (boucle de log sur stdout, dump binaire) remplirait la
       mémoire du miroir sans limite.

     • DÉMARRAGE — si Python est absent, spawn échoue en ENOENT. Sans
       traitement dédié, l'utilisateur voit « spawn python3 ENOENT »
       dans l'UI ; on renvoie à la place un « kind » que node_helper sait
       traduire en consigne actionnable, et on neutralise l'écriture sur
       le stdin d'un processus qui n'existe pas (EPIPE non intercepté sur
       un flux fait tomber tout le miroir).

   Aucune dépendance à MagicMirror : testable tel quel, avec n'importe
   quel exécutable en guise d'interpréteur.
   ===================================================================== */

const { spawn } = require('child_process');
const fs        = require('fs');

const { parseBridgeResponse, bridgeError } = require('./bridge-protocol');

/* pronotepy interroge Pronote semaine par semaine : la collecte complète
 * demande légitimement plusieurs dizaines de secondes. */
const DEFAULT_TIMEOUT_MS = 120000;

/* Délai laissé à Python pour sortir proprement sur SIGTERM avant le
 * SIGKILL. Court : le pont n'a rien à finaliser, le fichier de jetons est
 * écrit de façon atomique (tmp + fsync + rename). */
const KILL_GRACE_MS = 3000;

/* 16 Mio — deux ordres de grandeur au-dessus de la plus grosse réponse
 * observée, donc infranchissable en fonctionnement normal. */
const DEFAULT_MAX_STDOUT = 16 * 1024 * 1024;

/**
 * Exécute le pont et résout avec la charge utile (`data`).
 *
 * @param {object}   opts
 * @param {string}   opts.python      interpréteur à lancer
 * @param {string}   opts.script      chemin du pont Python
 * @param {object}   opts.payload     commande JSON à écrire sur stdin
 * @param {number}  [opts.timeoutMs]
 * @param {number}  [opts.maxStdout]
 * @param {number}  [opts.killGraceMs] délai SIGTERM → SIGKILL
 * @param {string}  [opts.cwd]
 * @param {function}[opts.onLog]      appelée pour chaque ligne de stderr
 * @param {function}[opts.onSpawn]    appelée avec le PID de l'enfant lancé
 * @returns {Promise<object>} rejetée avec une Error portant `.kind`
 */
function runBridge (opts) {
  const options   = opts || {};
  const python    = options.python;
  const script    = options.script;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxStdout = options.maxStdout || DEFAULT_MAX_STDOUT;
  const killGrace = options.killGraceMs === undefined ? KILL_GRACE_MS : options.killGraceMs;
  const onLog     = typeof options.onLog === 'function' ? options.onLog : () => {};
  const onSpawn   = typeof options.onSpawn === 'function' ? options.onSpawn : () => {};

  return new Promise((resolve, reject) => {
    if (!fs.existsSync(script)) {
      return reject(bridgeError('bridge_missing', `Pont introuvable : ${script}`));
    }

    let child;
    try {
      child = spawn(python, [script], {
        cwd: options.cwd,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
      });
    } catch (e) {
      /* spawn lève de façon synchrone sur un argument invalide ; ENOENT,
       * lui, arrive de façon asynchrone via l'événement « error ». */
      return reject(bridgeError('no_python', `Impossible de lancer Python (${python}) : ${e.message}`));
    }

    /* Le PID est connu dès le retour de spawn, avant même que l'enfant
     * n'ait produit la moindre sortie. C'est la seule façon fiable de
     * savoir quel processus surveiller : un enfant tué pendant son
     * démarrage n'écrit jamais rien. */
    if (child.pid !== undefined) onSpawn(child.pid);

    const chunks     = [];
    let   stdoutSize = 0;
    let   stderrBuf  = '';
    let   stderrTail = '';
    let   settled    = false;
    let   closed     = false;
    let   killTimer  = null;

    const timeoutTimer = setTimeout(() => {
      settle(bridgeError('timeout',
        `Timeout : Pronote ne répond pas (${Math.round(timeoutMs / 1000)}s)`));
      stopChild();
    }, timeoutMs);

    /* Arrêt en deux temps. Le SIGKILL n'est armé que si « close » n'est
     * pas arrivé entre-temps ; les deux timers sont unref pour qu'un
     * arrêt de MagicMirror ne soit pas retenu par eux. */
    function stopChild () {
      if (closed) return;
      try { child.kill('SIGTERM'); } catch { /* déjà mort */ }
      killTimer = setTimeout(() => {
        if (closed) return;
        try { child.kill('SIGKILL'); } catch { /* déjà mort */ }
      }, killGrace);
      if (typeof killTimer.unref === 'function') killTimer.unref();
    }

    /* Résout ou rejette une seule fois. On ne coupe PAS les écouteurs de
     * l'enfant au passage : « close » doit encore pouvoir désarmer le
     * SIGKILL et confirmer la récolte du processus. */
    function settle (err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (err) reject(err); else resolve(value);
    }

    /* Écrire sur le stdin d'un processus mort émet « error » sur le flux.
     * Un événement « error » sans écouteur est relancé comme exception :
     * il ferait tomber le processus MagicMirror entier. */
    child.stdin.on('error', () => {});

    child.stdout.on('data', chunk => {
      stdoutSize += chunk.length;
      if (stdoutSize > maxStdout) {
        settle(bridgeError('oversize',
          `Le pont Python a dépassé ${Math.round(maxStdout / 1048576)} Mio sur stdout`));
        stopChild();
        return;
      }
      chunks.push(chunk);
    });

    /* Chaque ligne de stderr est une trace du pont — on la relaie au fil
     * de l'eau, et on garde la dernière : quand le pont meurt sans rien
     * écrire sur stdout, c'est elle qui porte la cause. */
    child.stderr.on('data', chunk => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop();
      for (const line of lines) {
        if (line.trim()) { onLog(line); stderrTail = line; }
      }
    });

    child.on('error', e => {
      /* ENOENT : l'interpréteur n'existe pas. Le distinguer d'un autre
       * échec de spawn évite d'envoyer l'utilisateur chercher un problème
       * Pronote alors que c'est Python qui manque. */
      if (e && e.code === 'ENOENT') {
        return settle(bridgeError('no_python',
          `Interpréteur Python introuvable (${python}). Lancez « npm run setup ».`));
      }
      settle(bridgeError('error', `Impossible de lancer Python (${python}) : ${e.message}`));
    });

    child.on('close', code => {
      closed = true;
      clearTimeout(killTimer);
      if (stderrBuf.trim()) { onLog(stderrBuf); stderrTail = stderrBuf; }

      /* Timeout ou dépassement de buffer : déjà tranché, le code de
       * sortie ne nous apprend plus rien. */
      if (settled) return;

      const result = parseBridgeResponse(Buffer.concat(chunks).toString('utf8'), code, stderrTail);
      if (result.ok) return settle(null, result.data);
      settle(bridgeError(result.kind, result.error));
    });

    /* L'enfant peut avoir déjà échoué (ENOENT) : l'écouteur d'erreur
     * posé plus haut absorbe alors l'EPIPE. */
    try {
      child.stdin.write(JSON.stringify(options.payload || {}));
      child.stdin.end();
    } catch { /* flux déjà fermé — « error »/« close » prennent le relais */ }
  });
}

module.exports = { runBridge, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_STDOUT, KILL_GRACE_MS };
