'use strict';
/* MMM-Pronotepy — module MagicMirror² pour Pronote
 * Copyright (C) 2024-2026 Aldarande
 * Licensed under the MIT License. See LICENSE for details.
 */

/* =====================================================================
   Tests de lib/private-cache.js.

   Le défaut corrigé ici est le plus grave rencontré sur ce module :

     GET /modules/MMM-Pronotepy/cache/tokens-default.json  →  200

   MagicMirror sert tout `modules/` en statique. Les jetons de
   reconnexion, l'identifiant Pronote et les prénoms des enfants étaient
   donc téléchargeables par quiconque atteint le port 8080 — et
   l'authentification des routes n'y changeait rien, puisqu'elle protège
   `/MMM-Pronotepy/*` et non `/modules/...`.

   Le point du nom de dossier est TOUT le correctif : `express.static`
   ignore les fichiers cachés. Ces tests existent pour qu'on ne le retire
   pas en le prenant pour une coquetterie.
   ===================================================================== */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const pc = require('../lib/private-cache');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-prive-'));

/* ── Ce qui protège réellement ───────────────────────────────────── */

test('le dossier de cache commence par un point', () => {
  /* C'est la totalité du correctif. `express.static` ignore les fichiers
   * cachés — vérifié en production : 404 sur un dossier en point, 200 sur
   * un fichier ordinaire du même répertoire. */
  assert.ok(pc.PRIVATE_DIR.startsWith('.'),
    'sans le point, les jetons redeviennent téléchargeables sur le réseau');
  assert.strictEqual(path.basename(pc.privateCacheDir('/x')), pc.PRIVATE_DIR);
});

test('l\'ancien dossier, lui, ne commence pas par un point', () => {
  /* Sinon la reprise n'aurait aucun sens. */
  assert.ok(!pc.LEGACY_DIR.startsWith('.'));
  assert.notStrictEqual(pc.PRIVATE_DIR, pc.LEGACY_DIR);
});

/* ── Reprise de l'existant ───────────────────────────────────────── */

test('les fichiers exposés sont déplacés, et l\'ancien dossier disparaît', (t) => {
  /* Les laisser en place maintiendrait la fuite ; imposer un rescan de QR
   * Code pour un défaut qui n'est pas celui de l'utilisateur serait pire. */
  const base = tmp();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  fs.mkdirSync(path.join(base, pc.LEGACY_DIR));
  fs.writeFileSync(path.join(base, pc.LEGACY_DIR, 'tokens-default.json'), '{"t":1}');
  fs.writeFileSync(path.join(base, pc.LEGACY_DIR, 'device_uuid.txt'), 'uuid');

  const bilan = pc.migrateLegacyCache(base);
  assert.strictEqual(bilan.migrated, true);
  assert.strictEqual(bilan.reason, 'ok');
  assert.deepStrictEqual(bilan.moved.sort(), ['device_uuid.txt', 'tokens-default.json']);

  assert.strictEqual(fs.existsSync(path.join(base, pc.LEGACY_DIR)), false,
    'le dossier exposé ne doit pas subsister');
  assert.strictEqual(
    fs.readFileSync(path.join(base, pc.PRIVATE_DIR, 'tokens-default.json'), 'utf8'), '{"t":1}');
});

test('la reprise est idempotente', (t) => {
  /* Elle tourne à chaque démarrage du miroir. */
  const base = tmp();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  fs.mkdirSync(path.join(base, pc.LEGACY_DIR));
  fs.writeFileSync(path.join(base, pc.LEGACY_DIR, 'a.json'), '1');

  assert.strictEqual(pc.migrateLegacyCache(base).migrated, true);
  assert.strictEqual(pc.migrateLegacyCache(base).reason, 'absent');
  assert.strictEqual(pc.migrateLegacyCache(base).reason, 'absent');
});

test('un fichier déjà présent côté privé fait foi', (t) => {
  /* Le fichier privé est plus récent par construction : c'est celui que
   * le module écrit depuis la mise à jour. L'écraser avec la copie
   * exposée ferait reculer les jetons — donc un rescan. */
  const base = tmp();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  fs.mkdirSync(path.join(base, pc.LEGACY_DIR));
  fs.mkdirSync(path.join(base, pc.PRIVATE_DIR));
  fs.writeFileSync(path.join(base, pc.LEGACY_DIR, 'tokens-default.json'), '{"vieux":1}');
  fs.writeFileSync(path.join(base, pc.PRIVATE_DIR, 'tokens-default.json'), '{"neuf":1}');

  pc.migrateLegacyCache(base);
  assert.strictEqual(
    fs.readFileSync(path.join(base, pc.PRIVATE_DIR, 'tokens-default.json'), 'utf8'),
    '{"neuf":1}');
  /* Et la copie exposée doit avoir disparu. */
  assert.strictEqual(fs.existsSync(path.join(base, pc.LEGACY_DIR, 'tokens-default.json')), false);
});

test('sans ancien dossier, la reprise ne fait rien', (t) => {
  const base = tmp();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const bilan = pc.migrateLegacyCache(base);
  assert.strictEqual(bilan.migrated, false);
  assert.strictEqual(bilan.reason, 'absent');
});

test('un dossier inaccessible ne fait pas échouer le démarrage', () => {
  assert.doesNotThrow(() => pc.migrateLegacyCache('/dossier/absent/vraiment'));
  assert.strictEqual(pc.migrateLegacyCache('/dossier/absent/vraiment').migrated, false);
});

/* ── Mise en place ───────────────────────────────────────────────── */

test('ensurePrivateCache crée le dossier et rend son chemin', (t) => {
  const base = tmp();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const { dir, bilan } = pc.ensurePrivateCache(base);
  assert.strictEqual(dir, path.join(base, pc.PRIVATE_DIR));
  assert.strictEqual(fs.existsSync(dir), true);
  assert.strictEqual(bilan.migrated, false);
});

test('ensurePrivateCache reprend l\'ancien dossier au passage', (t) => {
  const base = tmp();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  fs.mkdirSync(path.join(base, pc.LEGACY_DIR));
  fs.writeFileSync(path.join(base, pc.LEGACY_DIR, 'tokens-default.json'), '{"t":1}');

  const { dir, bilan } = pc.ensurePrivateCache(base);
  assert.strictEqual(bilan.migrated, true);
  assert.strictEqual(fs.existsSync(path.join(dir, 'tokens-default.json')), true);
});

/* ── Cohérence avec le pont Python ───────────────────────────────── */

test('le pont Python vise le même dossier', () => {
  /* Node déplace, Python lit : s'ils divergent, le module réclame un
   * rescan de QR Code sur un compte parfaitement valide. */
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'pronote_bridge.py'), 'utf8');
  const trouve = source.match(/CACHE_DIR\s*=\s*os\.path\.join\(BASE_DIR,\s*"([^"]+)"\)/);

  assert.ok(trouve, 'CACHE_DIR introuvable dans pronote_bridge.py');
  assert.strictEqual(trouve[1], pc.PRIVATE_DIR);
});
