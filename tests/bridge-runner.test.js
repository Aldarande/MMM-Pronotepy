'use strict';
/* MMM-Pronotepy — module MagicMirror² pour Pronote
 * Copyright (C) 2024-2026 Aldarande
 * Licensed under the MIT License. See LICENSE for details.
 */

/* =====================================================================
   Tests de lib/bridge-runner.js — le lancement du pont Python.

   Aucun Python requis : l'« interpréteur » est le node courant, et les
   faux ponts de tests/helpers/ rejouent chacun une façon de mal se
   terminer. C'est exactement ce qu'on ne peut pas provoquer à la
   demande en production — un PRONOTE qui ne répond plus, un Python
   désinstallé, un pont qui déverse sur stdout.
   ===================================================================== */

const test    = require('node:test');
const assert  = require('node:assert');
const path    = require('node:path');
const fs      = require('node:fs');

const { runBridge } = require('../lib/bridge-runner');

const NODE    = process.execPath;
const HELPERS = path.join(__dirname, 'helpers');
const faux    = nom => path.join(HELPERS, nom);

/* Le processus est-il encore là ? Sous Linux, un enfant non récolté reste
 * visible dans /proc à l'état « Z » : c'est le zombie qu'on traque, et
 * `kill(pid, 0)` ne le distingue pas d'un processus vivant. */
function processusPresent (pid) {
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const etat = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
      return { present: true, zombie: etat === 'Z' };
    } catch {
      return { present: false, zombie: false };
    }
  }
  try { process.kill(pid, 0); return { present: true, zombie: false }; }
  catch { return { present: false, zombie: false }; }
}

const attendre = ms => new Promise(r => setTimeout(r, ms));

/* ── Chemin nominal ───────────────────────────────────────────────── */

test('la charge utile transite par stdin et revient décodée', async () => {
  const data = await runBridge({
    python: NODE, script: faux('echo.js'),
    payload: { action: 'fetch', childName: 'Hugo' }
  });
  assert.deepStrictEqual(data.echo, { action: 'fetch', childName: 'Hugo' });
});

test('stderr est relayé ligne par ligne', async () => {
  const lignes = [];
  await runBridge({
    python: NODE, script: faux('echo.js'), payload: {},
    onLog: l => lignes.push(l)
  });
  assert.deepStrictEqual(lignes, ['pont demarre']);
});

test('un refus applicatif conserve son « kind »', async () => {
  await assert.rejects(
    runBridge({ python: NODE, script: faux('refuse.js'), payload: {} }),
    err => {
      assert.strictEqual(err.kind, 'auth_failed');
      assert.match(err.message, /Jeton expire/);
      return true;
    }
  );
});

test('une sortie non nulle remonte la dernière trace de stderr', async () => {
  /* Sans cela, l'utilisateur ne voit que « code 3 » : le message Python
   * est la seule information exploitable. */
  await assert.rejects(
    runBridge({ python: NODE, script: faux('crash.js'), payload: {} }),
    err => {
      assert.match(err.message, /code 3/);
      assert.match(err.message, /le serveur a ferme la session/);
      return true;
    }
  );
});

test('une sortie non-JSON en code 0 est signalée comme illisible', async () => {
  await assert.rejects(
    runBridge({ python: NODE, script: faux('garbage.js'), payload: {} }),
    /illisible/
  );
});

/* ── Python absent ────────────────────────────────────────────────── */

test('ENOENT donne une consigne actionnable, pas une pile d\'appels', async () => {
  await assert.rejects(
    runBridge({ python: 'python-qui-nexiste-pas-4242', script: faux('echo.js'), payload: {} }),
    err => {
      assert.strictEqual(err.kind, 'no_python');
      assert.match(err.message, /npm run setup/);
      /* Le message ne doit pas exposer les internes de Node. */
      assert.doesNotMatch(err.message, /ENOENT|spawn /);
      return true;
    }
  );
});

test('un interpréteur absent ne fait pas tomber le processus', async () => {
  /* Écrire sur le stdin d'un enfant qui n'a pas démarré émet « error »
   * sur le flux ; sans écouteur, Node relance l'exception et MagicMirror
   * s'arrête en entier. Le test échouerait par crash, pas par assertion. */
  const rejets = [];
  process.on('unhandledRejection', e => rejets.push(e));
  await runBridge({ python: 'inexistant-4242', script: faux('echo.js'), payload: {} })
    .catch(() => {});
  await attendre(50);
  assert.deepStrictEqual(rejets, []);
});

test('pont Python absent du disque', async () => {
  await assert.rejects(
    runBridge({ python: NODE, script: faux('ce-fichier-nexiste-pas.py'), payload: {} }),
    err => {
      assert.strictEqual(err.kind, 'bridge_missing');
      return true;
    }
  );
});

/* ── Bornes ───────────────────────────────────────────────────────── */

test('le timeout rejette avec le kind « timeout »', async () => {
  await assert.rejects(
    runBridge({
      python: NODE, script: faux('stubborn.js'), payload: {},
      timeoutMs: 200, killGraceMs: 100
    }),
    err => {
      assert.strictEqual(err.kind, 'timeout');
      assert.match(err.message, /ne répond pas/);
      return true;
    }
  );
});

test('stdout est borné : au-delà, la collecte est interrompue', async () => {
  await assert.rejects(
    runBridge({
      python: NODE, script: faux('flood.js'), payload: {},
      maxStdout: 256 * 1024, timeoutMs: 10000, killGraceMs: 100
    }),
    err => {
      assert.strictEqual(err.kind, 'oversize');
      return true;
    }
  );
});

test('un pont qui déverse sur stdout est bien tué, pas seulement abandonné', async () => {
  let pid = null;
  await runBridge({
    python: NODE, script: faux('flood.js'), payload: {},
    maxStdout: 128 * 1024, timeoutMs: 10000, killGraceMs: 100,
    onSpawn: p => { pid = p; }
  }).catch(() => {});

  assert.ok(pid, 'le faux pont doit avoir été lancé');
  for (let essai = 0; essai < 30 && processusPresent(pid).present; essai++) await attendre(100);
  assert.strictEqual(processusPresent(pid).present, false,
    'la borne de stdout doit tuer l\'enfant, pas seulement cesser de le lire');
});

/* ── Critère d'acceptation : aucun zombie après 20 cycles ─────────── */

test('20 cycles en timeout ne laissent aucun processus derrière eux', async () => {
  const CYCLES = 20;
  const pids   = [];

  for (let i = 0; i < CYCLES; i++) {
    await runBridge({
      python: NODE, script: faux('stubborn.js'), payload: { cycle: i },
      timeoutMs: 150, killGraceMs: 100,
      /* Le PID est relevé au lancement, pas dans la sortie de l'enfant :
       * un processus tué pendant son démarrage n'écrit jamais rien, et
       * c'est justement celui qu'il faut surveiller. */
      onSpawn: pid => pids.push(pid)
    }).then(
      () => assert.fail('le pont obstiné ne devrait jamais aboutir'),
      err => assert.strictEqual(err.kind, 'timeout')
    );
  }

  assert.strictEqual(pids.length, CYCLES, 'les 20 enfants doivent avoir démarré');
  assert.strictEqual(new Set(pids).size, CYCLES, 'chaque cycle doit lancer son propre processus');

  /* SIGTERM est ignoré par stubborn.js : la disparition ne peut venir que
   * de l'escalade SIGKILL. On laisse au système le temps de récolter. */
  let restants = [];
  for (let essai = 0; essai < 40; essai++) {
    restants = pids.filter(pid => processusPresent(pid).present);
    if (restants.length === 0) break;
    await attendre(100);
  }

  const zombies = pids.filter(pid => processusPresent(pid).zombie);
  assert.deepStrictEqual(zombies, [], 'aucun enfant ne doit rester à l\'état zombie');
  assert.deepStrictEqual(restants, [], 'aucun enfant ne doit survivre au timeout');
});
