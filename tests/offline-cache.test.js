'use strict';
/* MMM-Pronotepy — module MagicMirror² pour Pronote
 * Copyright (C) 2024-2026 Aldarande
 * Licensed under the MIT License. See LICENSE for details.
 */

/* =====================================================================
   Tests de lib/offline-cache.js — le repli hors ligne.

   L'enjeu n'est pas de servir le cache, c'est de refuser de le servir au
   bon moment. Une donnée périmée est ici PIRE qu'une absence de donnée :
   « timetableToday » veut dire « les cours d'aujourd'hui », pas « ces
   cours-là ». Rejouer la veille enverrait un enfant en cours avec le
   mauvais cartable — un écran d'erreur, lui, n'affirme rien de faux.

   D'où la règle qui prime sur toutes les autres et qu'aucun réglage ne
   peut assouplir : le cache ne franchit jamais minuit.
   ===================================================================== */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const cache = require('../lib/offline-cache');

const H = 3600000;
const M = 60000;

/** Un instant précis, pour raisonner sans dépendre de l'heure du test. */
const t = (jour, heure, minute = 0) => new Date(2026, 8, jour, heure, minute, 0).getTime();

const entree = (quand) => ({ collectedAt: new Date(quand).toISOString(), data: { name: 'Alice' } });

/* ── La règle du même jour ───────────────────────────────────────── */

test('le cache ne franchit pas minuit, même dans la fenêtre d\'âge', () => {
  /* 23h50 la veille → 00h10 : deux heures d'âge à peine, largement dans
   * un maxAge de 6 h. Et pourtant refusé : l'emploi du temps affiché
   * serait celui d'hier. C'est le cœur de ce fichier. */
  const verdict = cache.evaluate({
    entry:    entree(t(8, 23, 50)),
    now:      t(9, 0, 10),
    maxAgeMs: 6 * H
  });
  assert.strictEqual(verdict.usable, false);
  assert.strictEqual(verdict.reason, 'other-day');
  assert.ok(verdict.ageMs < 6 * H, 'l\'âge seul ne suffisait pas à le rejeter');
});

test('aucun maxAge ne permet de contourner la règle du jour', () => {
  for (const maxAgeMs of [12 * H, 24 * H, 365 * 24 * H]) {
    const verdict = cache.evaluate({
      entry: entree(t(8, 18)), now: t(9, 7), maxAgeMs
    });
    assert.strictEqual(verdict.reason, 'other-day', `maxAge ${maxAgeMs} devrait rester sans effet`);
  }
});

test('dans la même journée, le cache est servi', () => {
  const verdict = cache.evaluate({
    entry: entree(t(9, 7, 30)), now: t(9, 9, 15), maxAgeMs: 6 * H
  });
  assert.strictEqual(verdict.usable, true);
  assert.strictEqual(verdict.reason, 'ok');
  assert.strictEqual(verdict.ageMs, 105 * M);
});

/* ── Âge ─────────────────────────────────────────────────────────── */

test('au-delà de maxAge, le cache est refusé', () => {
  const verdict = cache.evaluate({
    entry: entree(t(9, 1)), now: t(9, 23), maxAgeMs: 6 * H
  });
  assert.strictEqual(verdict.usable, false);
  assert.strictEqual(verdict.reason, 'too-old');
});

test('la limite exacte est acceptée', () => {
  const verdict = cache.evaluate({
    entry: entree(t(9, 8)), now: t(9, 14), maxAgeMs: 6 * H
  });
  assert.strictEqual(verdict.usable, true);
});

test('une horloge qui recule ne rend pas le cache utilisable', () => {
  /* Un Raspberry Pi sans pile démarre en 1970 puis se recale par NTP :
   * pendant ce laps, « maintenant » précède la collecte. */
  const verdict = cache.evaluate({
    entry: entree(t(9, 10)), now: t(9, 8), maxAgeMs: 6 * H
  });
  assert.strictEqual(verdict.usable, false);
  assert.strictEqual(verdict.reason, 'future');
});

/* ── Absence et corruption ───────────────────────────────────────── */

test('rien à servir', () => {
  assert.strictEqual(cache.evaluate({ entry: null }).reason, 'no-cache');
  assert.strictEqual(cache.evaluate({ entry: {} }).reason, 'no-cache');
  assert.strictEqual(cache.evaluate({ entry: { data: null } }).reason, 'no-cache');
  assert.strictEqual(cache.evaluate({}).reason, 'no-cache');
  assert.strictEqual(cache.evaluate().reason, 'no-cache');
});

test('un horodatage illisible est refusé, pas interprété', () => {
  const verdict = cache.evaluate({
    entry: { collectedAt: 'hier matin', data: { name: 'Alice' } }, now: t(9, 9)
  });
  assert.strictEqual(verdict.usable, false);
  assert.strictEqual(verdict.reason, 'invalid');
});

test('maxAge nul désactive le repli', () => {
  const verdict = cache.evaluate({
    entry: entree(t(9, 9)), now: t(9, 9, 5), maxAgeMs: 0
  });
  assert.strictEqual(verdict.usable, false);
  assert.strictEqual(verdict.reason, 'disabled');
});

/* ── Analyse de la durée ─────────────────────────────────────────── */

test('parseMaxAge comprend les suffixes', () => {
  assert.strictEqual(cache.parseMaxAge('30s'), 30000);
  assert.strictEqual(cache.parseMaxAge('90m'), 90 * M);
  assert.strictEqual(cache.parseMaxAge('6h'), 6 * H);
  assert.strictEqual(cache.parseMaxAge('1d'), 24 * H);
});

test('les formes de désactivation rendent 0', () => {
  /* Contrairement à parseInterval, qui retombe sur 15 min : ici une
   * valeur vide veut dire « désactivé », pas « six heures ». */
  for (const valeur of [null, undefined, false, 0, '0', '', '   ', 'false', 'off', 'jamais', '6']) {
    assert.strictEqual(cache.parseMaxAge(valeur), 0, `« ${valeur} » devrait désactiver`);
  }
});

/* ── Nom de fichier ──────────────────────────────────────────────── */

test('la clé est dérivée du prénom, pas de l\'identifiant d\'instance', () => {
  /* L'identifiant MagicMirror change dès qu'on réordonne config.js ;
   * le cache serait perdu sans raison. */
  assert.strictEqual(cache.cacheKey('Alice'), 'alice');
  assert.strictEqual(cache.cacheKey('Hugo MARTIN'), 'hugo-martin');
  assert.strictEqual(cache.cacheKey('Éloïse'), 'eloise');
});

test('un prénom vide retombe sur une clé stable', () => {
  for (const valeur of ['', null, undefined, '   ']) {
    assert.strictEqual(cache.cacheKey(valeur), 'defaut');
  }
});

test('le prénom ne peut pas s\'échapper du dossier de cache', () => {
  /* Il vient de config.js, donc d'une source de confiance — raison de
   * plus pour ne pas avoir à s'y fier. */
  const dir = path.join(os.tmpdir(), 'mmm-test');
  for (const hostile of ['../../etc/passwd', '..\\..\\windows', '/etc/shadow', 'a/b']) {
    const fichier = cache.cacheFile(dir, hostile);
    assert.strictEqual(path.dirname(fichier), dir, `« ${hostile} » sort du dossier`);
  }
});

/* ── Aller-retour sur disque ─────────────────────────────────────── */

test('écriture puis relecture', (t2) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-cache-'));
  t2.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const charge = { name: 'Alice MARTIN', timetableToday: [{ subject: 'Maths' }] };
  assert.strictEqual(cache.save(dir, 'Alice', charge, t(9, 8, 41)), 'written');

  const relu = cache.load(dir, 'Alice');
  assert.deepStrictEqual(relu.data, charge);
  assert.strictEqual(new Date(relu.collectedAt).getTime(), t(9, 8, 41));

  /* Le .tmp doit avoir été renommé, pas laissé derrière. */
  assert.deepStrictEqual(
    fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), []);
});

test('deux enfants ne se marchent pas dessus', (t2) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-cache-'));
  t2.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  cache.save(dir, 'Hugo', { name: 'Hugo' });
  cache.save(dir, 'Alice', { name: 'Alice' });

  assert.strictEqual(cache.load(dir, 'Hugo').data.name, 'Hugo');
  assert.strictEqual(cache.load(dir, 'Alice').data.name, 'Alice');
});

test('un cache corrompu se comporte comme un cache absent', (t2) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-cache-'));
  t2.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  fs.writeFileSync(cache.cacheFile(dir, 'Alice'), '{ ceci n\'est pas du JSON');
  assert.strictEqual(cache.load(dir, 'Alice'), null);
  assert.strictEqual(cache.evaluate({ entry: cache.load(dir, 'Alice') }).reason, 'no-cache');
});

test('un cache absent ne lève pas', () => {
  assert.strictEqual(cache.load('/dossier/qui/nexiste/pas', 'Alice'), null);
});

test('une écriture impossible ne fait pas échouer la collecte', (t2) => {
  /* Le cache est un confort ; une collecte réussie ne doit jamais être
   * perdue parce qu'on n'a pas pu l'archiver.
   *
   * Pour rendre l'écriture impossible de façon déterministe et portable,
   * on désigne comme « dossier » un chemin dont le parent est un FICHIER
   * ordinaire : mkdir y échoue en ENOTDIR, tout de suite et partout. Ne
   * pas viser /proc, où mkdir peut bloquer au lieu d'échouer — c'est ce
   * qui a fait tourner cette suite en boucle avant correction. */
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-cache-'));
  t2.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const fichier = path.join(base, 'ceci-est-un-fichier');
  fs.writeFileSync(fichier, 'x');
  const impossible = path.join(fichier, 'sous-dossier');

  assert.doesNotThrow(() => cache.save(impossible, 'Alice', { a: 1 }));
  assert.strictEqual(cache.save(impossible, 'Alice', { a: 1 }), 'failed');
  assert.strictEqual(cache.load(impossible, 'Alice'), null);
});

test('le fichier n\'est lisible que par son propriétaire', { skip: process.platform === 'win32' }, (t2) => {
  /* Il contient les notes, les absences et les punitions — même
   * traitement que le fichier de jetons. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-cache-'));
  t2.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  cache.save(dir, 'Alice', { grades: [{ value: 15.5 }] });
  const mode = fs.statSync(cache.cacheFile(dir, 'Alice')).mode & 0o777;
  assert.strictEqual(mode.toString(8), '600');

  /* Une réécriture ne doit pas relâcher les permissions : writeFileSync
   * n'applique `mode` qu'à la création. */
  cache.save(dir, 'Alice', { grades: [{ value: 12 }] });
  assert.strictEqual((fs.statSync(cache.cacheFile(dir, 'Alice')).mode & 0o777).toString(8), '600');
});

/* ── Économie d'écritures (usure des cartes SD) ──────────────────── */

test('une charge utile identique n\'est pas réécrite', (t2) => {
  /* MagicMirror tourne sur Raspberry Pi : réécrire quatre fois par heure
   * des octets identiques use la carte sans rien apporter. Les nuits,
   * week-ends et vacances — la majorité de l'année — produisent
   * exactement la même charge utile d'un cycle à l'autre. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-cache-'));
  t2.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const charge = { name: 'Alice', homeworks: [{ subject: 'Maths' }] };
  assert.strictEqual(cache.save(dir, 'Alice', charge, t(9, 8)), 'written');

  const avant = fs.statSync(cache.cacheFile(dir, 'Alice')).mtimeMs;
  assert.strictEqual(cache.save(dir, 'Alice', charge, t(9, 8, 15)), 'unchanged');
  assert.strictEqual(cache.save(dir, 'Alice', charge, t(9, 8, 30)), 'unchanged');
  assert.strictEqual(fs.statSync(cache.cacheFile(dir, 'Alice')).mtimeMs, avant,
    'le fichier ne doit pas avoir été touché');
});

test('une charge utile modifiée est écrite', (t2) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-cache-'));
  t2.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  cache.save(dir, 'Alice', { homeworks: [] }, t(9, 8));
  assert.strictEqual(
    cache.save(dir, 'Alice', { homeworks: [{ subject: 'Maths' }] }, t(9, 8, 15)),
    'written');
});

test('l\'horodatage est rafraîchi passé le délai, même sans changement', (t2) => {
  /* Sans cela, un cache inchangé depuis le matin garderait l'horodatage
   * du matin et serait jugé périmé alors qu'il vient d'être confirmé. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-cache-'));
  t2.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const charge = { name: 'Alice' };
  cache.save(dir, 'Alice', charge, t(9, 8));

  assert.strictEqual(cache.save(dir, 'Alice', charge, t(9, 8, 45)), 'unchanged');
  assert.strictEqual(cache.save(dir, 'Alice', charge, t(9, 9, 30)), 'written');
  assert.strictEqual(
    new Date(cache.load(dir, 'Alice').collectedAt).getTime(), t(9, 9, 30));
});

test('au pire, 24 écritures par jour pour une charge utile figée', () => {
  /* Le délai de rafraîchissement borne l'usure : quel que soit
   * l'updateInterval, un contenu qui ne bouge pas ne peut pas coûter
   * plus d'une écriture par heure. */
  assert.strictEqual(24 * 3600000 / cache.REFRESH_AFTER_MS, 24);
});
