'use strict';
/* MMM-Pronotepy — module MagicMirror² pour Pronote
 * Copyright (C) 2024-2026 Aldarande
 * Licensed under the MIT License. See LICENSE for details.
 */

/* =====================================================================
   Fenêtres horaires de l'emploi du temps.

   Le module frontend s'exécute normalement dans le navigateur de
   MagicMirror. On le charge ici avec un faux `Module.register` qui
   capture sa définition — exactement la technique qu'emploie
   MMM-Remote-Control pour lire les `defaults` d'un module. Rien d'autre
   n'est évalué au chargement, donc rien à simuler de plus.

   Ce qui est éprouvé : `today` et `nextDay` restreignent la fenêtre de
   la section sans jamais l'élargir. Une erreur ici ne se voit pas — une
   section simplement absente de l'écran ressemble à une absence de
   données.
   ===================================================================== */

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('node:path');

/* Capture de la définition du module. */
let mod = null;
global.Module = { register: (nom, definition) => { mod = definition; } };
require(path.join(__dirname, '..', 'MMM-Pronotepy.js'));

/** Un instant du jour, heure locale. */
const a = (heure, minute = 0) => new Date(2026, 8, 14, heure, minute, 0);

/* ── La primitive ────────────────────────────────────────────────── */

test('la définition du module est bien captée', () => {
  assert.ok(mod, 'Module.register n\'a pas été appelé');
  assert.strictEqual(typeof mod._inWindow, 'function');
  assert.strictEqual(typeof mod._isSubVisible, 'function');
});

test('sans horaires, la fenêtre est toujours ouverte', () => {
  assert.strictEqual(mod._inWindow({}, a(3)), true);
  assert.strictEqual(mod._inWindow(null, a(3)), true);
});

test('une tranche simple est respectée', () => {
  const cfg = { showFrom: '06:00', showUntil: '09:30' };
  assert.strictEqual(mod._inWindow(cfg, a(5, 59)), false);
  assert.strictEqual(mod._inWindow(cfg, a(6, 0)),  true);
  assert.strictEqual(mod._inWindow(cfg, a(9, 30)), true);
  assert.strictEqual(mod._inWindow(cfg, a(9, 31)), false);
});

test('plusieurs tranches restent possibles', () => {
  const cfg = { showRanges: [{ from: '06:00', until: '09:00' },
                             { from: '17:00', until: '22:00' }] };
  assert.strictEqual(mod._inWindow(cfg, a(7)),  true);
  assert.strictEqual(mod._inWindow(cfg, a(12)), false);
  assert.strictEqual(mod._inWindow(cfg, a(18)), true);
});

/* ── Le besoin : aujourd'hui le matin, demain le soir ────────────── */

test('today et nextDay ont chacun leur fenêtre', () => {
  /* Le cas visé : ne pas afficher deux emplois du temps à la fois. Le
   * matin celui du jour, le soir celui du lendemain. */
  const tt = {
    display: true, showFrom: '00:00', showUntil: '23:59',
    today:   { showFrom: '06:00', showUntil: '14:00' },
    nextDay: { showFrom: '17:00', showUntil: '23:59' }
  };

  const matin = a(7, 30);
  assert.strictEqual(mod._isSubVisible(tt, 'today',   matin), true);
  assert.strictEqual(mod._isSubVisible(tt, 'nextDay', matin), false);

  const soir = a(19, 0);
  assert.strictEqual(mod._isSubVisible(tt, 'today',   soir), false);
  assert.strictEqual(mod._isSubVisible(tt, 'nextDay', soir), true);

  /* Entre les deux, aucun des deux — c'est voulu : l'écran laisse la
   * place aux autres sections. */
  const creux = a(15, 30);
  assert.strictEqual(mod._isSubVisible(tt, 'today',   creux), false);
  assert.strictEqual(mod._isSubVisible(tt, 'nextDay', creux), false);
});

/* ── Héritage et souveraineté de la section ──────────────────────── */

test('sans sous-bloc, on hérite de la fenêtre de section', () => {
  /* Rétrocompatibilité : une configuration existante ne doit rien
   * changer à son comportement. */
  const tt = { display: true, showFrom: '08:00', showUntil: '20:00' };
  assert.strictEqual(mod._isSubVisible(tt, 'today', a(12)), true);
  assert.strictEqual(mod._isSubVisible(tt, 'today', a(21)), false);
  assert.strictEqual(mod._isSubVisible(tt, 'nextDay', a(12)), true);
});

test('un sous-bloc restreint mais n\'élargit jamais', () => {
  /* Sinon un réglage de sous-bloc pourrait rallumer une section que l'on
   * a explicitement éteinte — l'utilisateur perdrait la main. */
  const tt = {
    display: true, showFrom: '08:00', showUntil: '12:00',
    today: { showFrom: '00:00', showUntil: '23:59' }
  };
  assert.strictEqual(mod._isSubVisible(tt, 'today', a(10)), true);
  assert.strictEqual(mod._isSubVisible(tt, 'today', a(15)), false,
    'la fenêtre de section doit rester souveraine');
});

test('display:false éteint tout, sous-blocs compris', () => {
  const tt = { display: false, today: { showFrom: '00:00', showUntil: '23:59' } };
  assert.strictEqual(mod._isSubVisible(tt, 'today', a(10)), false);
});

test('un sous-bloc peut porter plusieurs tranches', () => {
  const tt = {
    display: true,
    today: { showRanges: [{ from: '06:00', until: '08:00' },
                          { from: '11:00', until: '13:00' }] }
  };
  assert.strictEqual(mod._isSubVisible(tt, 'today', a(7)),  true);
  assert.strictEqual(mod._isSubVisible(tt, 'today', a(9)),  false);
  assert.strictEqual(mod._isSubVisible(tt, 'today', a(12)), true);
});

/* ── Les défauts ne changent rien ────────────────────────────────── */

test('les défauts laissent les deux sous-blocs visibles', () => {
  /* `today` et `nextDay` valent null par défaut : le module se comporte
   * comme avant l'ajout de la fonctionnalité. */
  const tt = mod.defaults.Timetable;
  assert.strictEqual(tt.today, null);
  assert.strictEqual(tt.nextDay, null);

  for (const heure of [0, 6, 12, 18, 23]) {
    assert.strictEqual(mod._isSubVisible(tt, 'today', a(heure)), true);
    assert.strictEqual(mod._isSubVisible(tt, 'nextDay', a(heure)), true);
  }
});

test('_isVisible reste cohérent avec _inWindow', () => {
  /* _isVisible = display ET fenêtre. Les deux ne doivent pas diverger. */
  const cfg = { display: true, showFrom: '09:00', showUntil: '17:00' };
  for (const heure of [8, 9, 12, 17, 18]) {
    assert.strictEqual(mod._isVisible(cfg, a(heure)),
                       mod._inWindow(cfg, a(heure)),
                       `divergence à ${heure} h`);
  }
  assert.strictEqual(mod._isVisible({ display: false, showFrom: '00:00' }, a(12)), false);
});
