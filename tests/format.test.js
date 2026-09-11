'use strict';
/* MMM-Pronotepy — module MagicMirror² pour Pronote
 * Copyright (C) 2024-2026 Aldarande
 * Licensed under the MIT License. See LICENSE for details.
 */

/* =====================================================================
   Tests de lib/format.js — la localisation de la charge utile.

   Le pont Python ne renvoie que de l'ISO ; c'est ici que les dates
   deviennent lisibles. Les pièges éprouvés : une date nue interprétée
   en UTC qui recule d'un jour, et une charge utile incomplète qui ferait
   tomber le rendu du miroir.
   ===================================================================== */

const test   = require('node:test');
const assert = require('node:assert');

const {
  formatTime, formatDate, localize, parseInterval, DEFAULT_INTERVAL_MS
} = require('../lib/format');

const FR = 'fr-FR';

/* ── Heures ──────────────────────────────────────────────────────── */

test('les heures sortent en 24 h', () => {
  assert.strictEqual(formatTime('2026-09-05T14:05:00', FR), '14:05');
  assert.strictEqual(formatTime('2026-09-05T08:00:00', FR), '08:00');
});

test('une heure absente ou invalide rend une chaîne vide', () => {
  /* Le gabarit Nunjucks teste la vérité de la valeur : « Invalid Date »
   * s'afficherait tel quel sur le miroir. */
  for (const brut of ['', null, undefined, 'pas une date']) {
    assert.strictEqual(formatTime(brut, FR), '');
  }
});

/* ── Dates ───────────────────────────────────────────────────────── */

test('une date nue ne recule pas d\'un jour', () => {
  /* « 2026-09-05 » est interprété en UTC par Date ; à l'ouest de
   * Greenwich, le rendu tomberait sur le 4. On force midi local. */
  assert.strictEqual(
    formatDate('2026-09-05', FR, { day: 'numeric', month: 'numeric', year: 'numeric' }),
    '05/09/2026');
});

test('un horodatage complet garde son jour', () => {
  assert.strictEqual(
    formatDate('2026-09-05T23:30:00', FR, { day: 'numeric', month: 'numeric', year: 'numeric' }),
    '05/09/2026');
});

test('une date absente ou invalide rend une chaîne vide', () => {
  for (const brut of ['', null, undefined, 'hier']) {
    assert.strictEqual(formatDate(brut, FR, {}), '');
  }
});

/* ── Charge utile complète ───────────────────────────────────────── */

test('localize met en forme sans altérer les autres champs', () => {
  const brut = {
    name: 'Hugo MARTIN',
    className: '5B',
    establishment: 'Collège Victor Hugo',
    timetableToday: [
      { subject: 'Maths', start: '2026-09-05T08:00:00', end: '2026-09-05T09:00:00',
        teacher: 'M. Durand', room: 'B12', cancelled: false }
    ],
    cancelledToday: 1,
    todayStart: '2026-09-05T08:00:00',
    todayEnd:   '2026-09-05T17:00:00',
    timetableNextDay: {
      date: '2026-09-08', start: '2026-09-08T09:00:00', end: '2026-09-08T16:00:00',
      daysUntil: 3,
      classes: [{ subject: 'SVT', start: '2026-09-08T09:00:00', end: '2026-09-08T10:00:00' }]
    },
    homeworks: [{ subject: 'Anglais', description: 'Lire p. 42',
                  deadline: '2026-09-08', done: false, dueTomorrow: false }],
    grades:    [{ subject: 'Maths', value: 15.5, outOf: 20, date: '2026-09-01T00:00:00' }],
    absences:  [{ date: '2026-09-01', reason: 'Maladie', justified: true }],
    delays:    [{ date: '2026-09-02', duration: 10 }],
    punishments: [{ date: '2026-09-03', type: 'Retenue' }]
  };

  const vu = localize(brut, FR);

  assert.strictEqual(vu.name, 'Hugo MARTIN');
  assert.strictEqual(vu.className, '5B');
  assert.strictEqual(vu.timetableToday[0].start, '08:00');
  assert.strictEqual(vu.timetableToday[0].end, '09:00');
  /* Les champs non temporels traversent intacts. */
  assert.strictEqual(vu.timetableToday[0].teacher, 'M. Durand');
  assert.strictEqual(vu.timetableToday[0].room, 'B12');

  assert.strictEqual(vu.todayStart, '08:00');
  assert.strictEqual(vu.todayEnd, '17:00');
  assert.strictEqual(vu.cancelledToday, 1);

  assert.strictEqual(vu.timetableNextDay.daysUntil, 3);
  assert.match(vu.timetableNextDay.day, /mardi 8 septembre/);
  assert.strictEqual(vu.timetableNextDay.classes[0].start, '09:00');

  assert.match(vu.homeworks[0].deadline, /8 sept/);
  assert.strictEqual(vu.homeworks[0].description, 'Lire p. 42');

  /* La note garde sa date ISO tronquée pour les regroupements côté
   * gabarit, en plus de sa version lisible. */
  assert.strictEqual(vu.grades[0].date, '2026-09-01');
  assert.ok(vu.grades[0].formattedDate);
  assert.strictEqual(vu.grades[0].value, 15.5);

  assert.strictEqual(vu.absences[0].formattedDate, '1 sept. 2026');
  assert.strictEqual(vu.absences[0].justified, true);
  assert.ok(vu.delays[0].formattedDate);
  assert.ok(vu.punishments[0].formattedDate);
});

test('une charge utile vide donne une structure complète', () => {
  /* Le pont peut répondre partiellement (onglet non accessible) ; le
   * gabarit parcourt ces tableaux sans les tester. */
  const vu = localize({}, FR);

  assert.deepStrictEqual(vu.timetableToday, []);
  assert.deepStrictEqual(vu.homeworks, []);
  assert.deepStrictEqual(vu.grades, []);
  assert.deepStrictEqual(vu.absences, []);
  assert.deepStrictEqual(vu.delays, []);
  assert.deepStrictEqual(vu.punishments, []);
  assert.deepStrictEqual(vu.children, []);
  assert.strictEqual(vu.name, '');
  assert.strictEqual(vu.noClassesToday, false);
  assert.strictEqual(vu.timetableNextDay.daysUntil, null);
  assert.deepStrictEqual(vu.timetableNextDay.classes, []);
});

test('localize ne lève pas sur une charge utile absente', () => {
  assert.doesNotThrow(() => localize(null, FR));
  assert.doesNotThrow(() => localize(undefined, FR));
});

test('daysUntil à 0 n\'est pas confondu avec « inconnu »', () => {
  /* `?? null` et non `|| null` : 0 jour, c'est aujourd'hui. */
  const vu = localize({ timetableNextDay: { daysUntil: 0 } }, FR);
  assert.strictEqual(vu.timetableNextDay.daysUntil, 0);
});

test('la langue est respectée', () => {
  const vu = localize({ absences: [{ date: '2026-09-01' }] }, 'en-GB');
  assert.match(vu.absences[0].formattedDate, /Sep/);
});

/* ── Intervalle de rafraîchissement ──────────────────────────────── */

test('parseInterval comprend les suffixes', () => {
  assert.strictEqual(parseInterval('30s'), 30000);
  assert.strictEqual(parseInterval('15m'), 900000);
  assert.strictEqual(parseInterval('2h'), 7200000);
  assert.strictEqual(parseInterval('1d'), 86400000);
});

test('une valeur incomprise retombe sur l\'intervalle par défaut', () => {
  /* Un intervalle mal orthographié ne doit pas devenir une boucle de
   * rafraîchissement — chaque cycle fait tourner le jeton Pronote, et
   * leur accumulation a déjà valu une suspension d'adresse IP. Le repli
   * vaut le défaut du module, et non une valeur plus courte : sinon un
   * réglage fautif interrogerait Pronote plus souvent que ce que la
   * documentation annonce. */
  for (const brut of ['', 'soixante minutes', '60', '60min', null, undefined, '0m', '0s']) {
    assert.strictEqual(parseInterval(brut), DEFAULT_INTERVAL_MS,
      `« ${brut} » devrait retomber sur le défaut`);
  }
});

test('le repli est aligné sur le défaut annoncé par le module', () => {
  /* Si les deux divergent, la documentation ment sur la fréquence réelle
   * dès qu'un réglage est mal orthographié. */
  assert.strictEqual(DEFAULT_INTERVAL_MS, 60 * 60 * 1000);
  assert.strictEqual(parseInterval('60m'), DEFAULT_INTERVAL_MS);
  assert.strictEqual(parseInterval('1h'), DEFAULT_INTERVAL_MS);
});
