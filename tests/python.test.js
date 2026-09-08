'use strict';
/* MMM-Pronotepy — module MagicMirror² pour Pronote
 * Copyright (C) 2024-2026 Aldarande
 * Licensed under the MIT License. See LICENSE for details.
 */

/* =====================================================================
   Tests de lib/python.js — le choix de l'interpréteur.

   Ce choix se fait une seule fois, au premier cycle, et se voit
   uniquement dans une ligne de log ; quand il se trompe, le symptôme
   remonte plusieurs secondes plus tard sous la forme d'un ImportError
   ou d'un ENOENT, à l'autre bout du pont. D'où ces tests : le système
   de fichiers est injecté, rien n'est lancé.
   ===================================================================== */

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('node:path');

const { resolvePython } = require('../lib/python');

const VENV = path.join('/opt/mmm', '.venv');
const VENV_POSIX = path.join(VENV, 'bin', 'python');
const VENV_WIN   = path.join(VENV, 'Scripts', 'python.exe');

/** Faux système de fichiers : seuls les chemins listés existent. */
const fauxFs = (...presents) => (chemin) => presents.includes(chemin);
const rien   = () => false;

/* ── Priorités ───────────────────────────────────────────────────── */

test('la variable d\'environnement prime sur tout le reste', () => {
  const vu = resolvePython({
    fromEnv:    '/usr/bin/python3.13',
    configured: '/autre/python',
    venvDir:    VENV,
    exists:     fauxFs('/usr/bin/python3.13', '/autre/python', VENV_POSIX)
  });
  assert.strictEqual(vu.command, '/usr/bin/python3.13');
  assert.strictEqual(vu.source, 'env');
});

test('pythonPath prime sur le venv', () => {
  /* C'est tout l'intérêt de l'option : le venv du module n'est pas
   * toujours le bon interpréteur. */
  const vu = resolvePython({
    configured: '/opt/partage/venv/bin/python',
    venvDir:    VENV,
    exists:     fauxFs('/opt/partage/venv/bin/python', VENV_POSIX)
  });
  assert.strictEqual(vu.command, '/opt/partage/venv/bin/python');
  assert.strictEqual(vu.source, 'config');
});

test('le venv du module est le cas nominal', () => {
  const vu = resolvePython({ venvDir: VENV, exists: fauxFs(VENV_POSIX) });
  assert.strictEqual(vu.command, VENV_POSIX);
  assert.strictEqual(vu.source, 'venv');
  assert.strictEqual(vu.level, 'info');
});

test('le venv Windows est reconnu', () => {
  const vu = resolvePython({ venvDir: VENV, platform: 'win32', exists: fauxFs(VENV_WIN) });
  assert.strictEqual(vu.command, VENV_WIN);
  assert.strictEqual(vu.source, 'venv');
});

test('sans rien, on retombe sur l\'interpréteur du système', () => {
  assert.strictEqual(
    resolvePython({ venvDir: VENV, platform: 'linux', exists: rien }).command, 'python3');
  assert.strictEqual(
    resolvePython({ venvDir: VENV, platform: 'win32', exists: rien }).command, 'python');
});

test('le repli système est un avertissement, pas une information', () => {
  /* Le Python du système n'a aucune raison d'avoir pronotepy : la
   * collecte échouera quelques secondes plus tard sur un ImportError.
   * Il faut que la ligne de log le dise avant. */
  const vu = resolvePython({ venvDir: VENV, exists: rien });
  assert.strictEqual(vu.source, 'system');
  assert.strictEqual(vu.level, 'warn');
  assert.match(vu.message, /npm run setup/);
  assert.match(vu.message, /pythonPath/);
  assert.match(vu.message, /Docker/);
});

/* ── Réglages vides ──────────────────────────────────────────────── */

test('un réglage vide vaut « non renseigné »', () => {
  /* config.js écrit volontiers `pythonPath: ""` ou `null` pour dire
   * « laisse faire » : cela ne doit pas court-circuiter le venv. */
  for (const vide of ['', '   ', null, undefined]) {
    const vu = resolvePython({ configured: vide, fromEnv: vide,
                               venvDir: VENV, exists: fauxFs(VENV_POSIX) });
    assert.strictEqual(vu.source, 'venv', `« ${vide} » ne devrait pas être retenu`);
  }
});

test('les espaces autour du chemin sont retirés', () => {
  const vu = resolvePython({ configured: '  /usr/bin/python3  ',
                             exists: fauxFs('/usr/bin/python3') });
  assert.strictEqual(vu.command, '/usr/bin/python3');
});

/* ── Réglage explicite mais faux ─────────────────────────────────── */

test('un chemin explicite absent est honoré ET signalé', () => {
  /* Retomber silencieusement sur le venv masquerait la faute de frappe
   * et ferait interroger Pronote par un autre interpréteur que celui
   * demandé. On avertit, et on laisse l'échec de lancement trancher. */
  const vu = resolvePython({
    configured: '/chemin/faux/python',
    venvDir:    VENV,
    exists:     fauxFs(VENV_POSIX)
  });
  assert.strictEqual(vu.command, '/chemin/faux/python');
  assert.strictEqual(vu.source, 'config');
  assert.strictEqual(vu.level, 'warn');
  assert.match(vu.message, /introuvable/);
  assert.match(vu.message, /pythonPath/);
});

test('le message nomme la source du réglage fautif', () => {
  /* Avec deux sources possibles, « chemin introuvable » sans dire
   * laquelle envoie chercher au mauvais endroit. */
  const parEnv = resolvePython({ fromEnv: '/faux/python', exists: rien });
  assert.match(parEnv.message, /MMM_PRONOTEPY_PYTHON/);

  const parConfig = resolvePython({ configured: '/faux/python', exists: rien });
  assert.match(parConfig.message, /pythonPath/);
  assert.doesNotMatch(parConfig.message, /MMM_PRONOTEPY_PYTHON/);
});

test('un nom de commande nu est accepté sans vérification', () => {
  /* « python3.11 » se résout par le PATH : vérifier son existence
   * demanderait de réimplémenter les règles du système (PATHEXT sous
   * Windows…). On fait confiance, ENOENT dira le reste. */
  const vu = resolvePython({ configured: 'python3.11', venvDir: VENV, exists: rien });
  assert.strictEqual(vu.command, 'python3.11');
  assert.strictEqual(vu.level, 'info');
});

/* ── Robustesse ──────────────────────────────────────────────────── */

test('resolvePython ne lève pas sur des entrées absentes', () => {
  assert.doesNotThrow(() => resolvePython());
  assert.doesNotThrow(() => resolvePython({}));
  const vu = resolvePython({});
  assert.ok(vu.command, 'une commande doit toujours être proposée');
});

test('chaque résultat porte un message et un niveau', () => {
  const cas = [
    { fromEnv: '/usr/bin/python3', exists: fauxFs('/usr/bin/python3') },
    { configured: 'python3.12', exists: rien },
    { venvDir: VENV, exists: fauxFs(VENV_POSIX) },
    { venvDir: VENV, exists: rien }
  ];
  for (const entree of cas) {
    const vu = resolvePython(entree);
    assert.ok(vu.message && vu.message.length > 10);
    assert.ok(['info', 'warn'].includes(vu.level));
    assert.ok(['env', 'config', 'venv', 'system'].includes(vu.source));
  }
});
