'use strict';
/* MMM-Pronotepy — module MagicMirror² pour Pronote
 * Copyright (C) 2024-2026 Aldarande
 * Licensed under the MIT License. See LICENSE for details.
 */

/* =====================================================================
   Tests de lib/accounts.js — plusieurs comptes Pronote.

   Ce qui se joue ici est un NOMMAGE : une étiquette libre écrite dans
   config.js doit désigner le même fichier de jetons, vue de Node, du
   pont Python et de la page de configuration. Une divergence entre ces
   trois-là ne se verrait pas au démarrage ; elle se verrait le jour où
   un jeton serait cherché au mauvais endroit, et se lirait « rescannez
   un QR Code » sur un compte qui n'avait pourtant rien demandé.

   Deuxième enjeu : la reprise du fichier « tokens.json » des versions à
   compte unique. Une installation qui marche ne doit rien avoir à
   refaire.
   ===================================================================== */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const accounts = require('../lib/accounts');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-comptes-'));

/* ── Normalisation ───────────────────────────────────────────────── */

test('une étiquette lisible devient une clé de fichier sûre', () => {
  assert.strictEqual(accounts.normalize('college-alice'), 'college-alice');
  assert.strictEqual(accounts.normalize('Collège Alice'), 'college-alice');
  assert.strictEqual(accounts.normalize('Lycée  Hugo '), 'lycee-hugo');
  assert.strictEqual(accounts.normalize('COMPTE_2'), 'compte-2');
});

test('une étiquette absente donne le compte par défaut', () => {
  for (const valeur of [null, undefined, '', '   ', '---', '!!!']) {
    assert.strictEqual(accounts.normalize(valeur), accounts.DEFAULT_ACCOUNT,
      `${JSON.stringify(valeur)} devrait retomber sur le défaut`);
  }
});

test('la normalisation est idempotente', () => {
  /* Elle est appliquée à plusieurs endroits de la chaîne — au minimum à
   * la réception de la config et à chaque requête HTTP. Si elle ne
   * l'était pas, le compte changerait de nom en cours de route. */
  for (const brut of ['Collège Alice', 'a b c', 'ÉLÈVE', 'x'.repeat(80)]) {
    const une = accounts.normalize(brut);
    assert.strictEqual(accounts.normalize(une), une, `« ${brut} » n'est pas idempotent`);
  }
});

test('toute normalisation produit une clé que le pont Python acceptera', () => {
  /* Le pont valide `^[a-z0-9-]{1,48}$` avant d'en faire un chemin. Ce
   * qui sort d'ici doit passer cette validation, sinon le pont se
   * rabattrait silencieusement sur le compte par défaut — et écrirait
   * les jetons d'un établissement dans le fichier d'un autre. */
  const RE_PYTHON = /^[a-z0-9-]{1,48}$/;
  const entrees = ['Collège Alice', 'Lycée Hugo', '', null, 'x'.repeat(200),
                   '../../etc/passwd', 'compte/../autre', 'ÉÀÜÏÔ', '2026', '@#$%'];
  for (const brut of entrees) {
    const cle = accounts.normalize(brut);
    assert.match(cle, RE_PYTHON, `« ${brut} » produit une clé refusée par le pont`);
    assert.strictEqual(accounts.isSafeKey(cle), true);
  }
});

test('une étiquette ne peut pas s\'échapper du dossier de cache', () => {
  const dir = path.join(os.tmpdir(), 'mmm-test');
  for (const hostile of ['../../etc/passwd', '..\\..\\windows', '/etc/shadow', 'a/b/c']) {
    assert.strictEqual(path.dirname(accounts.tokenFile(dir, hostile)), dir,
      `« ${hostile} » sort du dossier`);
  }
});

test('deux étiquettes distinctes donnent deux fichiers distincts', () => {
  const dir = '/cache';
  assert.notStrictEqual(accounts.tokenFile(dir, 'alice'), accounts.tokenFile(dir, 'hugo'));
  assert.match(accounts.tokenFile(dir, 'alice'), /tokens-alice\.json$/);
});

/* ── Reprise du fichier historique ───────────────────────────────── */

test('tokens.json devient le compte par défaut', (t) => {
  /* Une installation existante ne doit rien avoir à refaire : le jeton
   * qui marchait hier doit marcher aujourd'hui. */
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, accounts.LEGACY_FILE),
                   JSON.stringify({ username: 'parent.exemple', primary: { token: 'abc' } }));

  const bilan = accounts.migrateLegacy(dir);
  assert.strictEqual(bilan.migrated, true);
  assert.strictEqual(fs.existsSync(path.join(dir, accounts.LEGACY_FILE)), false);

  const repris = accounts.loadTokens(dir, accounts.DEFAULT_ACCOUNT);
  assert.strictEqual(repris.username, 'parent.exemple');
  assert.strictEqual(repris.primary.token, 'abc');
});

test('la reprise est idempotente', (t) => {
  /* Elle tourne à chaque démarrage du miroir. */
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, accounts.LEGACY_FILE), '{"username":"a"}');
  assert.strictEqual(accounts.migrateLegacy(dir).migrated, true);
  assert.strictEqual(accounts.migrateLegacy(dir).reason, 'absent');
  assert.strictEqual(accounts.migrateLegacy(dir).reason, 'absent');
});

test('si les deux fichiers existent, on ne touche à rien', (t) => {
  /* Écraser un fichier de jetons valide coûterait un rescan de QR Code,
   * ce que la reprise est justement censée éviter. */
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dir, accounts.LEGACY_FILE), '{"username":"ancien"}');
  fs.writeFileSync(accounts.tokenFile(dir, accounts.DEFAULT_ACCOUNT), '{"username":"nouveau"}');

  const bilan = accounts.migrateLegacy(dir);
  assert.strictEqual(bilan.migrated, false);
  assert.strictEqual(bilan.reason, 'conflict');
  assert.strictEqual(accounts.loadTokens(dir, accounts.DEFAULT_ACCOUNT).username, 'nouveau');
  assert.strictEqual(fs.existsSync(path.join(dir, accounts.LEGACY_FILE)), true);
});

test('sans fichier historique, la reprise ne fait rien', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.strictEqual(accounts.migrateLegacy(dir).reason, 'absent');
});

test('un dossier de cache absent ne fait pas échouer le démarrage', () => {
  assert.doesNotThrow(() => accounts.migrateLegacy('/dossier/absent/vraiment'));
  assert.strictEqual(accounts.migrateLegacy('/dossier/absent/vraiment').migrated, false);
});

/* ── Inventaire ──────────────────────────────────────────────────── */

test('les comptes présents sur le disque sont listés', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  for (const nom of ['default', 'lycee-hugo', 'college-alice']) {
    fs.writeFileSync(accounts.tokenFile(dir, nom), '{}');
  }
  /* Bruit à ignorer : le cache hors ligne vit dans le même dossier. */
  fs.writeFileSync(path.join(dir, 'last-alice.json'), '{}');
  fs.writeFileSync(path.join(dir, 'device_uuid.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'tokens-default.json.tmp'), '{}');

  assert.deepStrictEqual(accounts.listStored(dir),
    ['college-alice', 'default', 'lycee-hugo']);
});

test('un dossier absent donne une liste vide, pas une erreur', () => {
  assert.deepStrictEqual(accounts.listStored('/dossier/absent/vraiment'), []);
});

/* ── Lecture et suppression ──────────────────────────────────────── */

test('chaque compte lit ses propres jetons', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(accounts.tokenFile(dir, 'alice'), '{"username":"parent-college"}');
  fs.writeFileSync(accounts.tokenFile(dir, 'hugo'),  '{"username":"eleve-lycee"}');

  assert.strictEqual(accounts.loadTokens(dir, 'alice').username, 'parent-college');
  assert.strictEqual(accounts.loadTokens(dir, 'hugo').username, 'eleve-lycee');
  assert.strictEqual(accounts.loadTokens(dir, 'inconnu'), null);
});

test('un fichier de jetons corrompu se lit comme absent', (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(accounts.tokenFile(dir, 'alice'), '{ pas du JSON');
  assert.strictEqual(accounts.loadTokens(dir, 'alice'), null);
});

test('supprimer un compte ne touche pas les autres', (t) => {
  /* Le bouton « supprimer les tokens » de la page de configuration :
   * effacer le compte affiché ne doit pas déconnecter la fratrie. */
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(accounts.tokenFile(dir, 'alice'), '{"username":"a"}');
  fs.writeFileSync(accounts.tokenFile(dir, 'hugo'),  '{"username":"b"}');

  assert.strictEqual(accounts.removeTokens(dir, 'alice'), true);
  assert.strictEqual(accounts.loadTokens(dir, 'alice'), null);
  assert.strictEqual(accounts.loadTokens(dir, 'hugo').username, 'b');

  /* Supprimer deux fois n'est pas une erreur. */
  assert.strictEqual(accounts.removeTokens(dir, 'alice'), false);
});

/* ── Cloisonnement du cache hors ligne ───────────────────────────── */

test('deux comptes peuvent avoir chacun une « Hugo »', () => {
  /* Sans le compte dans la clé, la Hugo du lycée écraserait la Hugo
   * du collège — et l'écran hors ligne afficherait l'emploi du temps de
   * la mauvaise. */
  const a = accounts.offlineKey('college-alice', 'Hugo');
  const b = accounts.offlineKey('lycee-hugo', 'Hugo');
  assert.notStrictEqual(a, b);
});

test('sans enfant, la clé est celle du compte', () => {
  /* Cas du compte élève : il n'y a pas d'enfant à choisir. */
  assert.strictEqual(accounts.offlineKey('lycee-hugo', null), 'lycee-hugo');
  assert.strictEqual(accounts.offlineKey('lycee-hugo', '  '), 'lycee-hugo');
});

test('la clé hors ligne suit la normalisation du compte', () => {
  assert.strictEqual(accounts.offlineKey('Collège Alice', 'Alice'), 'college-alice-Alice');
});
