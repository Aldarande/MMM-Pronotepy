'use strict';
/* MMM-Pronotepy — module MagicMirror² pour Pronote
 * Copyright (C) 2024-2026 Aldarande
 * Licensed under the MIT License. See LICENSE for details.
 */

/* =====================================================================
   Tests de lib/api-auth.js.

   C'est le correctif du finding F-005 (MMM/modules/SECURITY-AUDIT.md,
   2026-05-15) : les routes /MMM-Pronotepy/* divulguaient l'identifiant
   Pronote et les prénoms des enfants, et /api/clear supprimait les
   jetons — sans la moindre vérification d'identité, sur un miroir
   écoutant en 0.0.0.0 avec un ipWhitelist vide.

   Le défaut était déjà connu de MMM-Pawmote et a tout de même été
   recopié ici. Ces tests sont ce qui doit empêcher la troisième fois.
   ===================================================================== */

const test   = require('node:test');
const assert = require('node:assert');
const http   = require('node:http');
const os     = require('node:os');

const {
  createApiAuth, createFailureTracker, describeMode,
  safeEqual, isLoopback, presentedSecret,
  MIN_SECRET_LENGTH, MAX_FAILURES, LOCKOUT_MS
} = require('../lib/api-auth');

const SECRET = 'un-secret-suffisamment-long';

/* ── Doubles d'Express ───────────────────────────────────────────── */

function faireReq (options = {}) {
  const url = options.url || '/MMM-Pronotepy/api/status';
  return {
    method:      options.method || 'GET',
    url,
    originalUrl: url,
    headers:     options.headers || {},
    query:       options.query,
    /* `ip` est délibérément menteur dans les tests : le middleware ne
     * doit jamais le lire (il suit « trust proxy » et se pilote depuis
     * un en-tête X-Forwarded-For). */
    ip:          '127.0.0.1',
    socket:      { remoteAddress: options.ip === undefined ? '192.168.1.50' : options.ip }
  };
}

function faireRes () {
  const res = { statusCode: null, headers: {}, body: undefined, type: undefined };
  res.status = c => { res.statusCode = c; return res; };
  res.set    = (k, v) => { res.headers[k] = v; return res; };
  res.json   = b => { res.body = b; res.contentType = 'json'; return res; };
  res.send   = b => { res.body = b; return res; };
  res.type   = t => { res.contentType = t; return res; };
  return res;
}

/** Joue une requête ; rend { passe, res }. */
function jouer (middleware, options) {
  const req = faireReq(options);
  const res = faireRes();
  let passe = false;
  middleware(req, res, () => { passe = true; });
  return { passe, res };
}

const avecSecret = (secret, extra = {}) => createApiAuth(
  Object.assign({ moduleName: 'MMM-Pronotepy', getSecret: () => secret }, extra));

/* ── Repli loopback : aucune clé configurée ──────────────────────── */

test('sans clé configurée, une requête du LAN est refusée en 401', () => {
  /* Critère d'acceptation : curl http://<ip-lan>:8080/MMM-Pronotepy/api/status
   * depuis une autre machine renvoie 401. */
  const { passe, res } = jouer(avecSecret(''), { ip: '192.168.1.50' });
  assert.strictEqual(passe, false);
  assert.strictEqual(res.statusCode, 401);
  assert.deepStrictEqual(res.body, { error: 'Non autorisé' });
});

test('sans clé configurée, le miroir lui-même passe', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.1.1']) {
    const { passe } = jouer(avecSecret(''), { ip });
    assert.strictEqual(passe, true, `${ip} devrait être reconnue comme locale`);
  }
});

test('une clé trop courte est traitée comme absente', () => {
  /* Un secret de trois lettres ouvert sur tout le réseau vaut moins que
   * le repli loopback, qui est réellement fermé. */
  const courte = 'abc';
  assert.ok(courte.length < MIN_SECRET_LENGTH);

  const mw = avecSecret(courte);
  assert.strictEqual(jouer(mw, { ip: '192.168.1.50',
    headers: { 'x-api-key': courte } }).passe, false);
  assert.strictEqual(jouer(mw, { ip: '127.0.0.1' }).passe, true);
});

/* ── Ouverture explicite (allowUnauthenticated) ──────────────────── */

const ouvert = (valeur, secret) => createApiAuth({
  moduleName: 'MMM-Pronotepy',
  getSecret:  () => secret || '',
  getAllowUnauthenticated: () => valeur
});

test('allowUnauthenticated ouvre les routes au reseau', () => {
  /* Le besoin : atteindre la page de configuration depuis un telephone
   * sans avoir de cle a saisir. */
  const mw = ouvert(true);
  assert.strictEqual(jouer(mw, { ip: '192.168.1.50' }).passe, true);
  assert.strictEqual(jouer(mw, { ip: '10.0.0.7', url: '/MMM-Pronotepy/config' }).passe, true);
  assert.strictEqual(jouer(mw, { ip: '127.0.0.1' }).passe, true);
});

test('les formes textuelles sont acceptees', () => {
  /* La valeur peut venir d'une variable d'environnement, ou tout est
   * chaine de caracteres. */
  for (const valeur of [true, 'true', 'TRUE', '1', ' oui ', 'yes', 'on']) {
    assert.strictEqual(jouer(ouvert(valeur), { ip: '192.168.1.50' }).passe, true,
      JSON.stringify(valeur) + ' devrait ouvrir');
  }
});

test('tout le reste laisse le repli loopback en place', () => {
  /* Le defaut est ferme : seule une autorisation reconnue l ouvre. Un
   * `allowUnauthenticated: "peut-etre"` ne doit pas exposer le miroir. */
  for (const valeur of [false, 'false', '0', 'non', 'no', 'off', '', '   ',
                        null, undefined, 0, 'peut-etre', {}]) {
    const mw = ouvert(valeur);
    assert.strictEqual(jouer(mw, { ip: '192.168.1.50' }).passe, false,
      JSON.stringify(valeur) + ' ne devrait pas ouvrir');
    assert.strictEqual(jouer(mw, { ip: '127.0.0.1' }).passe, true);
  }
});

test('une cle configuree l emporte sur l ouverture', () => {
  /* Deux reglages contradictoires : on retient le plus ferme. Ouvrir
   * malgre une cle explicitement posee serait le pire des deux mondes. */
  const mw = ouvert(true, SECRET);
  assert.strictEqual(jouer(mw, { ip: '192.168.1.50' }).passe, false);
  assert.strictEqual(jouer(mw, { ip: '192.168.1.50',
    headers: { 'x-api-key': SECRET } }).passe, true);
});

test('la contradiction est signalee au demarrage', () => {
  /* Sans ce message, on croit l acces ouvert et on cherche longtemps
   * pourquoi on recoit des 401. */
  const etat = ouvert(true, SECRET).describeMode();
  assert.strictEqual(etat.mode, 'secret');
  assert.match(etat.message, /IGNOR/);
});

test('un getAllowUnauthenticated qui leve retombe sur le repli', () => {
  const mw = createApiAuth({
    moduleName: 'MMM-Pronotepy',
    getSecret:  () => '',
    getAllowUnauthenticated: () => { throw new Error('config illisible'); }
  });
  assert.strictEqual(jouer(mw, { ip: '192.168.1.50' }).passe, false);
  assert.strictEqual(jouer(mw, { ip: '127.0.0.1' }).passe, true);
});

test('le mode ouvert est annonce sans euphemisme', () => {
  const etat = describeMode('', true);
  assert.strictEqual(etat.mode, 'open');
  assert.strictEqual(etat.level, 'warn');
  /* Le message doit nommer ce qui est expose, pas seulement dire
   * « acces non authentifie ». */
  assert.match(etat.message, /jetons/);
  assert.match(etat.message, /enfants/);
  assert.match(etat.message, /apiKey/);
});

test('le message du mode loopback mentionne les deux issues', () => {
  const etat = describeMode('');
  assert.match(etat.message, /apiKey/);
  assert.match(etat.message, /allowUnauthenticated/);
});

test('describeMode garde son comportement a un seul argument', () => {
  /* Fichier partage : un appelant qui ignore l ouverture explicite doit
   * obtenir exactement le comportement d origine. */
  assert.strictEqual(describeMode(SECRET).mode, 'secret');
  assert.strictEqual(describeMode('').mode, 'loopback');
  assert.strictEqual(describeMode('abc').mode, 'loopback');
});

/* ── L'adresse ne se laisse pas dicter par un en-tête ────────────── */

test('X-Forwarded-For ne fabrique pas un accès local', () => {
  /* `req.ip` suit le réglage « trust proxy » d'Express : le lire
   * laisserait l'attaquant choisir son adresse. */
  const { passe, res } = jouer(avecSecret(''), {
    ip: '192.168.1.50',
    headers: { 'x-forwarded-for': '127.0.0.1', 'x-real-ip': '127.0.0.1' }
  });
  assert.strictEqual(passe, false);
  assert.strictEqual(res.statusCode, 401);
});

test('isLoopback lit la socket, jamais req.ip', () => {
  assert.strictEqual(isLoopback({ ip: '127.0.0.1', socket: { remoteAddress: '10.0.0.9' } }), false);
  assert.strictEqual(isLoopback({ ip: '10.0.0.9', socket: { remoteAddress: '127.0.0.1' } }), true);
  assert.strictEqual(isLoopback({}), false);
});

/* ── Clé configurée ──────────────────────────────────────────────── */

test('la clé est acceptée sur les trois canaux', () => {
  const mw = avecSecret(SECRET);

  assert.strictEqual(jouer(mw, { headers: { 'x-api-key': SECRET } }).passe, true);
  assert.strictEqual(jouer(mw, { headers: { authorization: `Bearer ${SECRET}` } }).passe, true);
  assert.strictEqual(jouer(mw, { query: { key: SECRET } }).passe, true);
});

test('la clé passée en query est lue même sans parseur Express', () => {
  /* Le middleware peut être monté avant express.query ; il retombe alors
   * sur l'analyse de l'URL. */
  const mw = avecSecret(SECRET);
  const url = `/MMM-Pronotepy/config?key=${encodeURIComponent(SECRET)}`;
  assert.strictEqual(jouer(mw, { url, query: undefined }).passe, true);
});

test('« Bearer » est insensible à la casse et tolère les espaces', () => {
  const mw = avecSecret(SECRET);
  assert.strictEqual(jouer(mw, { headers: { authorization: `bearer   ${SECRET} ` } }).passe, true);
});

test('une clé absente ou fausse est refusée en 401', () => {
  const mw = avecSecret(SECRET);
  assert.strictEqual(jouer(mw, {}).passe, false);
  assert.strictEqual(jouer(mw, { headers: { 'x-api-key': SECRET + 'x' } }).passe, false);
  assert.strictEqual(jouer(mw, { headers: { 'x-api-key': '' } }).passe, false);
  assert.strictEqual(jouer(mw, { headers: { 'x-api-key': SECRET.slice(0, -1) } }).passe, false);
});

test('avec une clé configurée, le local n\'est pas dispensé de la fournir', () => {
  /* Le repli loopback est un repli, pas un cumul : sinon, tout ce qui
   * tourne sur le miroir contournerait la clé. */
  const mw = avecSecret(SECRET);
  assert.strictEqual(jouer(mw, { ip: '127.0.0.1' }).passe, false);
  assert.strictEqual(jouer(mw, { ip: '127.0.0.1', headers: { 'x-api-key': SECRET } }).passe, true);
});

test('la clé est relue à chaque requête', () => {
  /* Elle arrive avec SET_CONFIG, donc après l'enregistrement des routes :
   * la figer au démarrage laisserait le module en repli loopback pour
   * toujours. */
  let secret = '';
  const mw = createApiAuth({ moduleName: 'MMM-Pronotepy', getSecret: () => secret });

  assert.strictEqual(jouer(mw, { headers: { 'x-api-key': SECRET } }).passe, false);
  secret = SECRET;
  assert.strictEqual(jouer(mw, { headers: { 'x-api-key': SECRET } }).passe, true);
});

test('un getSecret qui lève retombe sur le repli loopback', () => {
  const mw = createApiAuth({
    moduleName: 'MMM-Pronotepy',
    getSecret: () => { throw new Error('config illisible'); }
  });
  assert.strictEqual(jouer(mw, { ip: '192.168.1.50' }).passe, false);
  assert.strictEqual(jouer(mw, { ip: '127.0.0.1' }).passe, true);
});

/* ── Comparaison ─────────────────────────────────────────────────── */

test('safeEqual ne lève pas sur des longueurs différentes', () => {
  /* `crypto.timingSafeEqual` exige deux buffers de même taille — il lève
   * sinon, ce qui divulguerait la longueur du secret. */
  assert.strictEqual(safeEqual('a', 'un-secret-bien-plus-long'), false);
  assert.strictEqual(safeEqual('', SECRET), false);
  assert.strictEqual(safeEqual(SECRET, SECRET), true);
  assert.strictEqual(safeEqual('é', 'é'), true);
});

test('presentedSecret rend null quand rien n\'est présenté', () => {
  assert.strictEqual(presentedSecret(faireReq({})), null);
  assert.strictEqual(presentedSecret(faireReq({ headers: { authorization: 'Basic xyz' } })), null);
});

/* ── Anti-force-brute ────────────────────────────────────────────── */

test('après trop d\'échecs, l\'adresse est bloquée même avec la bonne clé', () => {
  let horloge = 1000;
  const mw = avecSecret(SECRET, { now: () => horloge });

  for (let i = 0; i < MAX_FAILURES; i++) {
    assert.strictEqual(jouer(mw, { headers: { 'x-api-key': 'faux' } }).passe, false);
  }
  assert.strictEqual(jouer(mw, { headers: { 'x-api-key': SECRET } }).passe, false,
    'la bonne clé ne doit pas déverrouiller pendant la fenêtre');

  horloge += LOCKOUT_MS + 1;
  assert.strictEqual(jouer(mw, { headers: { 'x-api-key': SECRET } }).passe, true,
    'la fenêtre écoulée, l\'utilisateur légitime doit repasser');
});

test('le blocage est propre à une adresse', () => {
  let horloge = 1000;
  const mw = avecSecret(SECRET, { now: () => horloge });

  for (let i = 0; i < MAX_FAILURES; i++) {
    jouer(mw, { ip: '192.168.1.50', headers: { 'x-api-key': 'faux' } });
  }
  assert.strictEqual(
    jouer(mw, { ip: '192.168.1.77', headers: { 'x-api-key': SECRET } }).passe, true);
});

test('un succès efface les échecs accumulés', () => {
  const mw = avecSecret(SECRET);
  for (let i = 0; i < MAX_FAILURES - 1; i++) {
    jouer(mw, { headers: { 'x-api-key': 'faux' } });
  }
  assert.strictEqual(jouer(mw, { headers: { 'x-api-key': SECRET } }).passe, true);
  for (let i = 0; i < MAX_FAILURES - 1; i++) {
    jouer(mw, { headers: { 'x-api-key': 'faux' } });
  }
  assert.strictEqual(jouer(mw, { headers: { 'x-api-key': SECRET } }).passe, true);
});

test('le suivi des échecs ne grossit pas indéfiniment', () => {
  const tracker = createFailureTracker();
  const debut = 1000;
  for (let i = 0; i < 300; i++) tracker.fail(`10.0.0.${i}`, debut);
  /* L'élagage se déclenche au-delà de 256 entrées ; toutes datent du même
   * instant, donc rien n'est encore périmé — on vérifie surtout qu'aucune
   * entrée n'est perdue à tort. */
  assert.ok(tracker._size() > 0);

  for (let i = 0; i < 300; i++) tracker.fail('10.1.0.1', debut + 60 * 60000);
  assert.ok(tracker._size() < 300, 'les entrées périmées doivent disparaître');
});

/* ── Forme des refus ─────────────────────────────────────────────── */

test('les routes API refusent en JSON, les pages en HTML', () => {
  const mw = avecSecret('');

  const api = jouer(mw, { url: '/MMM-Pronotepy/api/status' }).res;
  assert.strictEqual(api.contentType, 'json');
  assert.deepStrictEqual(api.body, { error: 'Non autorisé' });

  const page = jouer(mw, { url: '/MMM-Pronotepy/config' }).res;
  assert.strictEqual(page.contentType, 'html');
  assert.match(page.body, /401/);
  assert.match(page.body, /key=VOTRE_CLE/);
});

test('le refus annonce le schéma d\'authentification', () => {
  const { res } = jouer(avecSecret(''), {});
  assert.strictEqual(res.headers['WWW-Authenticate'], 'Bearer realm="MMM-Pronotepy"');
});

test('le refus ne dit pas pourquoi', () => {
  /* Distinguer « pas de clé configurée », « clé absente » et « clé
   * fausse » renseignerait l'attaquant sur l'état du miroir. */
  const sansCle  = jouer(avecSecret(''), { url: '/MMM-Pronotepy/api/status' }).res;
  const cleFausse = jouer(avecSecret(SECRET),
    { url: '/MMM-Pronotepy/api/status', headers: { 'x-api-key': 'faux' } }).res;

  assert.deepStrictEqual(sansCle.body, cleFausse.body);
  assert.strictEqual(sansCle.statusCode, cleFausse.statusCode);
});

/* ── Message de démarrage ────────────────────────────────────────── */

test('describeMode décrit les trois situations', () => {
  assert.deepStrictEqual(
    { mode: describeMode(SECRET).mode, level: describeMode(SECRET).level },
    { mode: 'secret', level: 'info' });

  const absente = describeMode('');
  assert.strictEqual(absente.mode, 'loopback');
  assert.strictEqual(absente.level, 'warn');
  assert.match(absente.message, /127\.0\.0\.1/);
  assert.match(absente.message, /apiKey/);

  const courte = describeMode('abc');
  assert.strictEqual(courte.mode, 'loopback');
  assert.strictEqual(courte.level, 'warn');
  assert.match(courte.message, /trop courte/);
});

test('le middleware expose son mode', () => {
  assert.strictEqual(avecSecret(SECRET).describeMode().mode, 'secret');
  assert.strictEqual(avecSecret('').describeMode().mode, 'loopback');
});

/* ── Bout en bout, sur une vraie socket ──────────────────────────── */

function adresseLanLocale () {
  for (const cartes of Object.values(os.networkInterfaces())) {
    for (const carte of cartes || []) {
      if (carte.family === 'IPv4' && !carte.internal) return carte.address;
    }
  }
  return null;
}

test('sur une vraie socket, le LAN prend un 401 et le local passe', async (t) => {
  const lan = adresseLanLocale();
  if (!lan) return t.skip('aucune interface réseau non locale disponible');

  /* Le miroir monte le middleware sur Express ; ici, un serveur http nu
   * plus une pellicule minimale des méthodes de réponse d'Express. Ce
   * qu'on éprouve, c'est l'adresse vue au niveau de la socket — la seule
   * chose qu'un double de requête ne peut pas prouver. */
  const mw = avecSecret('');
  const serveur = http.createServer((req, res) => {
    res.status = c => { res.statusCode = c; return res; };
    res.set    = (k, v) => { res.setHeader(k, v); return res; };
    res.type   = () => res;
    res.json   = b => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(b)); };
    res.send   = b => res.end(b);
    req.originalUrl = req.url;
    mw(req, res, () => { res.statusCode = 200; res.end('{"username":"hugo.martin"}'); });
  });

  await new Promise(r => serveur.listen(0, '0.0.0.0', r));
  const port = serveur.address().port;

  const appeler = hote => new Promise((resolve, reject) => {
    const requete = http.get(
      { host: hote, port, path: '/MMM-Pronotepy/api/status' },
      reponse => {
        let corps = '';
        reponse.on('data', c => { corps += c; });
        reponse.on('end', () => resolve({ code: reponse.statusCode, corps }));
      });
    requete.on('error', reject);
  });

  try {
    const depuisLeLan = await appeler(lan);
    assert.strictEqual(depuisLeLan.code, 401, `${lan} devrait être refusée`);
    assert.doesNotMatch(depuisLeLan.corps, /hugo\.martin/,
      'aucune donnée Pronote ne doit fuir dans une réponse refusée');

    const depuisLeMiroir = await appeler('127.0.0.1');
    assert.strictEqual(depuisLeMiroir.code, 200);
  } finally {
    await new Promise(r => serveur.close(r));
  }
});
