'use strict';
/* MMM-Pronotepy — module MagicMirror² pour Pronote
 * Copyright (C) 2024-2026 Aldarande
 * Licensed under the MIT License. See LICENSE for details.
 */

/* =====================================================================
   Tests de lib/quiet-hours.js — la fenêtre de nuit.

   Deux façons de se tromper, opposées et toutes deux silencieuses :

     • une fenêtre qui ne se déclenche jamais — on continue d'interroger
       Pronote toute la nuit, et rien ne le signale ;
     • une fenêtre qui ne se referme jamais — le miroir reste figé sur les
       données de la veille, et rien ne le signale non plus.

   Le passage de minuit est ce qui rend les deux faciles : 20:00 → 07:00
   est l'UNION de deux intervalles, pas leur intersection. Écrit
   naïvement, `from <= t && t < until` donne ici l'ensemble vide.
   ===================================================================== */

const test   = require('node:test');
const assert = require('node:assert');

const quiet = require('../lib/quiet-hours');

const NUIT = { from: '20:00', until: '07:00' };

/** Un instant du 9 septembre 2026, heure locale. */
const a = (heure, minute = 0) => new Date(2026, 8, 9, heure, minute, 0);

/* ── Le passage de minuit ────────────────────────────────────────── */

test('la fenêtre par défaut couvre bien la nuit', () => {
  for (const [heure, minute] of [[20, 0], [22, 30], [23, 59], [0, 0], [3, 15], [6, 59]]) {
    assert.strictEqual(quiet.isQuiet(NUIT, a(heure, minute)), true,
      `${heure}:${String(minute).padStart(2, '0')} devrait être dans la pause`);
  }
});

test('la journée reste hors de la fenêtre', () => {
  for (const [heure, minute] of [[7, 0], [8, 30], [12, 0], [17, 45], [19, 59]]) {
    assert.strictEqual(quiet.isQuiet(NUIT, a(heure, minute)), false,
      `${heure}:${String(minute).padStart(2, '0')} devrait être hors pause`);
  }
});

test('les bornes : début inclus, fin exclue', () => {
  /* 20:00 pile suspend ; 07:00 pile reprend. Sans cette convention, une
   * des deux bornes se comporterait autrement que l'autre selon le sens
   * du test — et personne ne saurait laquelle. */
  assert.strictEqual(quiet.isQuiet(NUIT, a(19, 59)), false);
  assert.strictEqual(quiet.isQuiet(NUIT, a(20, 0)),  true);
  assert.strictEqual(quiet.isQuiet(NUIT, a(6, 59)),  true);
  assert.strictEqual(quiet.isQuiet(NUIT, a(7, 0)),   false);
});

test('une fenêtre qui ne franchit pas minuit fonctionne aussi', () => {
  /* Quelqu'un peut vouloir suspendre pendant les cours, par exemple. */
  const journee = { from: '09:00', until: '17:00' };
  assert.strictEqual(quiet.isQuiet(journee, a(8, 59)), false);
  assert.strictEqual(quiet.isQuiet(journee, a(9, 0)),  true);
  assert.strictEqual(quiet.isQuiet(journee, a(16, 59)), true);
  assert.strictEqual(quiet.isQuiet(journee, a(17, 0)), false);
  assert.strictEqual(quiet.isQuiet(journee, a(23, 0)), false);
  assert.strictEqual(quiet.isQuiet(journee, a(3, 0)),  false);
});

/* ── Désactivation ───────────────────────────────────────────────── */

test('la pause se désactive de plusieurs façons', () => {
  for (const cfg of [null, false, { enabled: false }]) {
    assert.strictEqual(quiet.isQuiet(cfg, a(23, 0)), false,
      `${JSON.stringify(cfg)} devrait désactiver la pause`);
    assert.strictEqual(quiet.describe(cfg), null);
  }
});

test('sans réglage, les bornes par défaut s\'appliquent', () => {
  /* `quietHours` absent de config.js doit donner le comportement
   * annoncé par les valeurs par défaut du module. */
  assert.strictEqual(quiet.isQuiet(undefined, a(23, 0)), true);
  assert.strictEqual(quiet.isQuiet({}, a(23, 0)), true);
  assert.strictEqual(quiet.isQuiet({}, a(12, 0)), false);
});

test('une borne seule complète l\'autre par son défaut', () => {
  assert.strictEqual(quiet.isQuiet({ from: '22:00' }, a(21, 0)), false);
  assert.strictEqual(quiet.isQuiet({ from: '22:00' }, a(23, 0)), true);
  assert.strictEqual(quiet.isQuiet({ from: '22:00' }, a(6, 0)),  true);
});

/* ── En cas de doute, on n'interrompt pas ────────────────────────── */

test('un horaire illisible désactive la pause et le dit', () => {
  /* Se tromper en laissant tourner coûte quelques requêtes ; se tromper
   * en suspendant coûte la fonction entière, et sans le moindre signe. */
  for (const mauvais of ['20h', '25:00', '20:70', 'vingt heures', '', '2000', null, 42]) {
    const fenetre = quiet.describeWindow({ from: mauvais, until: '07:00' });
    assert.strictEqual(fenetre.active, false, `« ${mauvais} » ne devrait pas activer`);
    assert.strictEqual(fenetre.reason, 'invalid');
    assert.match(fenetre.message, /HH:MM/);
    assert.strictEqual(quiet.isQuiet({ from: mauvais, until: '07:00' }, a(23, 0)), false);
  }
});

test('deux bornes identiques sont ambiguës, donc refusées', () => {
  /* « from == until » peut vouloir dire toute la journée ou jamais. On
   * ne devine pas, et surtout on ne met pas un miroir en pause
   * permanente sur une ambiguïté. */
  const fenetre = quiet.describeWindow({ from: '20:00', until: '20:00' });
  assert.strictEqual(fenetre.active, false);
  assert.strictEqual(fenetre.reason, 'empty');
  assert.match(fenetre.message, /ambig/i);
  assert.strictEqual(quiet.isQuiet({ from: '20:00', until: '20:00' }, a(23, 0)), false);
});

test('un réglage du mauvais type est signalé, pas interprété', () => {
  const fenetre = quiet.describeWindow('20:00-07:00');
  assert.strictEqual(fenetre.active, false);
  assert.strictEqual(fenetre.reason, 'invalid');
  assert.match(fenetre.message, /objet/);
});

/* ── Analyse des horaires ────────────────────────────────────────── */

test('parseTimeOfDay rend des minutes depuis minuit', () => {
  assert.strictEqual(quiet.parseTimeOfDay('00:00'), 0);
  assert.strictEqual(quiet.parseTimeOfDay('07:00'), 420);
  assert.strictEqual(quiet.parseTimeOfDay('20:00'), 1200);
  assert.strictEqual(quiet.parseTimeOfDay('23:59'), 1439);
});

test('les écritures usuelles sont tolérées', () => {
  /* config.js s'écrit à la main : « 7:00 » et « 20h00 » sont des façons
   * naturelles de noter une heure, et les refuser n'apporterait rien. */
  assert.strictEqual(quiet.parseTimeOfDay('7:00'), 420);
  assert.strictEqual(quiet.parseTimeOfDay(' 20:00 '), 1200);
  assert.strictEqual(quiet.parseTimeOfDay('20h00'), 1200);
});

test('les horaires impossibles sont refusés', () => {
  for (const mauvais of ['24:00', '20:60', '99:99', '-1:00', '20:0', '20', ':30']) {
    assert.strictEqual(quiet.parseTimeOfDay(mauvais), null, `« ${mauvais} » devrait être refusé`);
  }
});

/* ── Libellé pour les logs ───────────────────────────────────────── */

test('describe rend une fenêtre lisible', () => {
  assert.strictEqual(quiet.describe(NUIT), '20:00 → 07:00');
  assert.strictEqual(quiet.describe({ from: '7:05', until: '9:00' }), '07:05 → 09:00');
});

test('describe rend null quand la pause est inactive', () => {
  assert.strictEqual(quiet.describe(null), null);
  assert.strictEqual(quiet.describe({ from: 'nawak' }), null);
});

/* ── Robustesse ──────────────────────────────────────────────────── */

test('isQuiet ne lève pas sur des entrées absurdes', () => {
  assert.doesNotThrow(() => quiet.isQuiet());
  assert.doesNotThrow(() => quiet.isQuiet(NUIT, new Date('pas une date')));
  assert.strictEqual(quiet.isQuiet(NUIT, new Date('pas une date')), false);
});

test('isQuiet accepte un horodatage numérique', () => {
  assert.strictEqual(quiet.isQuiet(NUIT, a(23, 0).getTime()), true);
  assert.strictEqual(quiet.isQuiet(NUIT, a(12, 0).getTime()), false);
});

/* ── Ce que la fenêtre économise ─────────────────────────────────── */

test('la fenêtre par défaut supprime bien 11 h de sondage sur 24', () => {
  /* 20:00 → 07:00, soit 11 heures : à quatre cycles par heure, ce sont
   * 44 authentifications PRONOTE et autant d'écritures de jeton en moins
   * chaque jour. C'est le but du réglage, autant le vérifier. */
  let enPause = 0;
  for (let minute = 0; minute < 24 * 60; minute++) {
    if (quiet.isQuiet(NUIT, a(0, minute))) enPause++;
  }
  assert.strictEqual(enPause, 11 * 60);
});
