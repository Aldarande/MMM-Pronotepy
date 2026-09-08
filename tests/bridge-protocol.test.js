'use strict';
/* MMM-Pronotepy — module MagicMirror² pour Pronote
 * Copyright (C) 2024-2026 Aldarande
 * Licensed under the MIT License. See LICENSE for details.
 */

/* =====================================================================
   Tests de lib/bridge-protocol.js — le décodage de la réponse du pont
   et le choix du message affiché.

   Ce sont les chemins d'erreur : ceux qu'on ne voit qu'un jour de panne,
   et où un message approximatif coûte une soirée à chercher au mauvais
   endroit.
   ===================================================================== */

const test   = require('node:test');
const assert = require('node:assert');

const { parseBridgeResponse, messageForKind, ERROR_MESSAGES } = require('../lib/bridge-protocol');

/* ── Décodage ────────────────────────────────────────────────────── */

test('une réponse valide rend la charge utile', () => {
  const res = parseBridgeResponse('{"ok":true,"data":{"name":"Hugo"}}', 0, '');
  assert.deepStrictEqual(res, { ok: true, data: { name: 'Hugo' } });
});

test('les espaces et retours à la ligne autour du JSON sont tolérés', () => {
  const res = parseBridgeResponse('\n  {"ok":true,"data":{}}  \n', 0, '');
  assert.strictEqual(res.ok, true);
});

test('« ok » sans « data » reste un succès', () => {
  /* Certaines actions ne renvoient que leur réussite ; en faire une
   * erreur casserait un cycle qui s'est pourtant bien passé. */
  const res = parseBridgeResponse('{"ok":true}', 0, '');
  assert.deepStrictEqual(res, { ok: true, data: {} });
});

test('un refus du pont conserve son « kind »', () => {
  const res = parseBridgeResponse('{"ok":false,"kind":"bad_pin","error":"PIN refusé"}', 0, '');
  assert.deepStrictEqual(res, { ok: false, kind: 'bad_pin', error: 'PIN refusé' });
});

test('un refus sans « kind » retombe sur « error »', () => {
  const res = parseBridgeResponse('{"ok":false}', 0, '');
  assert.strictEqual(res.kind, 'error');
  assert.match(res.error, /Erreur inconnue/);
});

test('une sortie illisible en code 0 est un bug du pont', () => {
  const res = parseBridgeResponse('Traceback…', 0, 'peu importe');
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /illisible/);
  assert.match(res.error, /Traceback/);
});

test('une sortie vide en code 0 le dit explicitement', () => {
  const res = parseBridgeResponse('', 0, '');
  assert.match(res.error, /\(vide\)/);
});

test('un code non nul remonte la dernière trace de stderr', () => {
  /* C'est la seule information exploitable quand Python meurt avant
   * d'avoir écrit quoi que ce soit sur stdout. */
  const res = parseBridgeResponse('', 1, 'PronoteAPIError: session fermée');
  assert.match(res.error, /code 1/);
  assert.match(res.error, /session fermée/);
});

test('un code non nul sans trace le signale plutôt que de mentir', () => {
  const res = parseBridgeResponse('', 137, '');
  assert.match(res.error, /aucune trace/);
});

test('la sortie illisible est tronquée', () => {
  /* Un dump de plusieurs mégaoctets ne doit pas se retrouver dans le
   * buffer de logs ni dans la notification envoyée au frontend. */
  const res = parseBridgeResponse('x'.repeat(5000), 0, '');
  assert.ok(res.error.length < 300);
});

test('un JSON valide mais non-objet est rejeté', () => {
  for (const brut of ['12', '"texte"', 'null', '[1,2]']) {
    const res = parseBridgeResponse(brut, 0, '');
    assert.strictEqual(res.ok, false, `${brut} ne devrait pas passer`);
  }
});

test('les entrées absentes ne font pas lever', () => {
  assert.strictEqual(parseBridgeResponse(undefined, 0, undefined).ok, false);
  assert.strictEqual(parseBridgeResponse(null, 1, null).ok, false);
});

/* ── Messages affichés ───────────────────────────────────────────── */

test('chaque « kind » a un message', () => {
  const attendus = [
    'no_tokens', 'bad_pin', 'qr_expired', 'bad_qr', 'outdated', 'auth_failed',
    'network', 'no_python', 'bridge_missing', 'timeout', 'oversize'
  ];
  for (const kind of attendus) {
    assert.ok(ERROR_MESSAGES[kind], `« ${kind} » n'a pas de message`);
    const message = messageForKind(kind, new Error('détail'));
    assert.ok(message.length > 10, `« ${kind} » : message trop court`);
  }
});

test('bad_pin et qr_expired ne disent pas la même chose', () => {
  /* Les deux remontent du même échec de déchiffrement AES ; les
   * confondre envoie l'utilisateur vérifier un PIN pourtant correct. */
  const pin = messageForKind('bad_pin', new Error(''));
  const qr  = messageForKind('qr_expired', new Error(''));

  assert.match(pin, /PIN/);
  assert.match(qr, /QR Code/);
  assert.doesNotMatch(qr, /PIN/);
});

test('les erreurs réseau reprennent le message d\'origine', () => {
  const message = messageForKind('network', new Error('Your IP address is suspended.'));
  assert.match(message, /Your IP address is suspended\./);
});

test('no_python donne la commande à taper', () => {
  assert.match(messageForKind('no_python', new Error('')), /npm run setup/);
});

test('un « kind » inconnu ne perd pas le message d\'origine', () => {
  const message = messageForKind('quelque_chose_de_neuf', new Error('détail utile'));
  assert.match(message, /détail utile/);
});

test('messageForKind supporte une erreur absente', () => {
  assert.doesNotThrow(() => messageForKind('network', undefined));
  assert.doesNotThrow(() => messageForKind('inconnu', null));
});
