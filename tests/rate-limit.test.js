'use strict';
/* MMM-Pronotepy — module MagicMirror² pour Pronote
 * Copyright (C) 2024-2026 Aldarande
 * Licensed under the MIT License. See LICENSE for details.
 */

/* =====================================================================
   Tests de lib/rate-limit.js — les garde-fous anti-suspension.

   Ce qu'ils protègent ne se voit pas en fonctionnement normal : ils ne
   servent que le jour où quelque chose s'emballe. Et le prix d'une
   défaillance n'est pas une erreur à l'écran, c'est une adresse IP
   suspendue pour tout le foyer — sanction subie en production sur le
   plugin ProJote.

   Les deux scénarios rejoués ici sont ceux constatés, pas des
   hypothèses : la rafale de rechargements de la page du miroir, et le
   redémarrage en boucle de MagicMirror.
   ===================================================================== */

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const rl = require('../lib/rate-limit');

const MIN = 60000;
const H   = 3600000;

/** Un instant du 12 septembre 2026, heure locale. */
const a = (heure, minute = 0) => new Date(2026, 8, 12, heure, minute, 0).getTime();

/* ── Le scénario de la rafale ────────────────────────────────────── */

test('vingt rechargements de page ne font qu\'une seule authentification', () => {
  /* Le cas le plus dangereux, et le moins visible : MagicMirror émet
   * ALL_MODULES_STARTED à chaque connexion d'un client, le frontend
   * renvoie SET_CONFIG, et le backend déclenchait une collecte immédiate.
   * Vingt rafraîchissements = vingt authentifications en quelques
   * secondes — le profil exact qui fait suspendre une IP. */
  let etat = rl.emptyState();
  let acceptees = 0;

  for (let i = 0; i < 20; i++) {
    const t = a(8, 0) + i * 3000;           // un rechargement toutes les 3 s
    if (rl.evaluate(etat, null, t).allowed) {
      acceptees++;
      etat = rl.afterAttempt(etat, t);
      etat = rl.afterOutcome(etat, t, { ok: true });
    }
  }
  assert.strictEqual(acceptees, 1);
});

test('le redémarrage en boucle est freiné', () => {
  /* Vécu : une erreur de syntaxe dans config.js faisait redémarrer
   * MagicMirror toutes les 60 s. Avec une config valide, chaque
   * démarrage aurait déclenché sa collecte — 60 authentifications par
   * heure. C'est pour ce cas que l'état est PERSISTÉ : un compteur en
   * mémoire serait remis à zéro à chaque redémarrage. */
  let etat = rl.emptyState();
  let acceptees = 0;

  for (let i = 0; i < 60; i++) {            // une heure de boucle
    const t = a(9, 0) + i * MIN;
    if (rl.evaluate(etat, null, t).allowed) {
      acceptees++;
      etat = rl.afterAttempt(etat, t);
      etat = rl.afterOutcome(etat, t, { ok: true });
    }
  }
  /* Un plancher de 5 min laisse passer 12 tentatives par heure au lieu
   * de 60. */
  assert.strictEqual(acceptees, 12);
});

/* ── Plancher entre deux tentatives ──────────────────────────────── */

test('le plancher s\'applique quelle que soit l\'origine de la collecte', () => {
  const etat = rl.afterAttempt(rl.emptyState(), a(8, 0));

  assert.strictEqual(rl.evaluate(etat, null, a(8, 1)).allowed, false);
  assert.strictEqual(rl.evaluate(etat, null, a(8, 4)).allowed, false);
  assert.strictEqual(rl.evaluate(etat, null, a(8, 5)).allowed, true);
});

test('la première collecte n\'est jamais bloquée', () => {
  /* Sinon un miroir fraîchement installé resterait vide sans explication. */
  assert.strictEqual(rl.evaluate(rl.emptyState(), null, a(8, 0)).allowed, true);
  assert.strictEqual(rl.evaluate(null, null, a(8, 0)).allowed, true);
  assert.strictEqual(rl.evaluate(undefined, undefined, undefined).allowed, true);
});

test('le blocage dit combien de temps attendre', () => {
  /* `retryAfterMs` sert au log : « pourquoi rien ne se passe ? » est la
   * question qu'on se pose devant un écran figé. */
  const etat = rl.afterAttempt(rl.emptyState(), a(8, 0));
  const v = rl.evaluate(etat, null, a(8, 2));
  assert.strictEqual(v.reason, 'min-interval');
  assert.strictEqual(v.retryAfterMs, 3 * MIN);
  assert.match(v.message, /plancher/i);
});

/* ── Recul après échec ───────────────────────────────────────────── */

test('le recul double à chaque échec, sans dépasser le plafond', () => {
  /* Réessayer au même rythme un serveur qui refuse ne le fera pas
   * changer d'avis — et alimente le compteur qui mène à la suspension. */
  const opts = rl.DEFAULTS;
  assert.strictEqual(rl.backoffMs(1, opts), 5 * MIN);
  assert.strictEqual(rl.backoffMs(2, opts), 10 * MIN);
  assert.strictEqual(rl.backoffMs(3, opts), 20 * MIN);
  assert.strictEqual(rl.backoffMs(10, opts), 6 * H, 'doit être plafonné');
  assert.strictEqual(rl.backoffMs(0, opts), 0);
});

test('après trois échecs, il faut attendre vingt minutes', () => {
  let etat = rl.emptyState();
  for (let i = 0; i < 3; i++) {
    const t = a(10, 0) + i * 30 * MIN;
    etat = rl.afterOutcome(rl.afterAttempt(etat, t), t, { ok: false, kind: 'network' });
  }
  const dernier = a(10, 0) + 2 * 30 * MIN;

  assert.strictEqual(rl.evaluate(etat, null, dernier + 19 * MIN).reason, 'backoff');
  assert.strictEqual(rl.evaluate(etat, null, dernier + 21 * MIN).allowed, true);
});

test('un succès efface le recul accumulé', () => {
  let etat = rl.emptyState();
  etat = rl.afterOutcome(etat, a(10, 0), { ok: false, kind: 'network' });
  etat = rl.afterOutcome(etat, a(10, 0), { ok: false, kind: 'network' });
  assert.strictEqual(etat.consecutiveFailures, 2);

  etat = rl.afterOutcome(etat, a(11, 0), { ok: true });
  assert.strictEqual(etat.consecutiveFailures, 0);
});

/* ── Suspension annoncée par PRONOTE ─────────────────────────────── */

test('une suspension gèle les collectes plusieurs heures', () => {
  /* C'est la seule erreur que réessayer AGGRAVE : chaque tentative
   * pendant la sanction la prolonge. */
  const t = a(12, 0);
  const etat = rl.afterOutcome(rl.afterAttempt(rl.emptyState(), t), t,
                               { ok: false, kind: 'ip_suspended' });

  const v = rl.evaluate(etat, null, a(14, 0));
  assert.strictEqual(v.allowed, false);
  assert.strictEqual(v.reason, 'suspended');
  assert.match(v.message, /suspension/i);

  assert.strictEqual(rl.evaluate(etat, null, a(17, 59)).allowed, false);
  assert.strictEqual(rl.evaluate(etat, null, a(18, 1)).allowed, true);
});

test('la suspension prime sur toutes les autres règles', () => {
  /* `reason` sert à expliquer le blocage : nommer « min-interval » alors
   * que l'IP est suspendue enverrait chercher au mauvais endroit. */
  let etat = rl.afterAttempt(rl.emptyState(), a(12, 0));
  etat = rl.afterOutcome(etat, a(12, 0), { ok: false, kind: 'ip_suspended' });
  etat.attemptsToday = 999;                 // plafond aussi dépassé

  assert.strictEqual(rl.evaluate(etat, null, a(12, 1)).reason, 'suspended');
});

test('un succès lève la suspension', () => {
  /* Si PRONOTE répond de nouveau, la sanction est levée — inutile de
   * rester gelé jusqu'au bout du délai. */
  let etat = rl.afterOutcome(rl.emptyState(), a(12, 0), { ok: false, kind: 'ip_suspended' });
  assert.ok(etat.suspendedUntil > 0);

  etat = rl.afterOutcome(etat, a(13, 0), { ok: true });
  assert.strictEqual(etat.suspendedUntil, 0);
});

/* ── Plafond quotidien ───────────────────────────────────────────── */

test('le plafond quotidien arrête tout au-delà de la limite', () => {
  /* Filet de dernier recours : si on l'atteint, c'est qu'un chemin nous a
   * échappé. Mieux vaut s'arrêter que le découvrir par une suspension. */
  const etat = Object.assign(rl.emptyState(), {
    day: rl.dayKey(a(15, 0)), attemptsToday: rl.DEFAULTS.dailyMaxAttempts, lastAttempt: a(8, 0)
  });
  const v = rl.evaluate(etat, null, a(15, 0));
  assert.strictEqual(v.allowed, false);
  assert.strictEqual(v.reason, 'daily-cap');
});

test('le compteur repart à minuit, heure locale', () => {
  /* Pas à minuit UTC : le plafond doit se réinitialiser à minuit chez
   * l'utilisateur. */
  const hier = new Date(2026, 8, 11, 23, 0, 0).getTime();
  const etat = Object.assign(rl.emptyState(), {
    day: rl.dayKey(hier), attemptsToday: 999, lastAttempt: hier
  });
  assert.strictEqual(rl.evaluate(etat, null, a(0, 30)).allowed, true);

  const apres = rl.afterAttempt(etat, a(0, 30));
  assert.strictEqual(apres.attemptsToday, 1, 'le compteur doit repartir de zéro');
});

/* ── Réglages ────────────────────────────────────────────────────── */

test('les bornes sont configurables', () => {
  const strict = { minIntervalMs: 30 * MIN };
  const etat = rl.afterAttempt(rl.emptyState(), a(8, 0));
  assert.strictEqual(rl.evaluate(etat, strict, a(8, 10)).allowed, false);
  assert.strictEqual(rl.evaluate(etat, strict, a(8, 31)).allowed, true);
});

test('un réglage partiel garde les autres défauts', () => {
  const etat = rl.afterOutcome(rl.emptyState(), a(8, 0), { ok: false, kind: 'network' });
  const v = rl.evaluate(rl.afterAttempt(etat, a(8, 0)), { dailyMaxAttempts: 5 }, a(8, 1));
  assert.strictEqual(v.reason, 'backoff', 'le backoff par défaut doit rester actif');
});

/* ── Persistance ─────────────────────────────────────────────────── */

test('l\'état survit à un redémarrage', (t) => {
  /* Sans cela, le garde-fou ne protège pas du redémarrage en boucle —
   * le scénario pour lequel il existe. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-rate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const etat = rl.afterAttempt(rl.emptyState(), a(8, 0));
  assert.strictEqual(rl.save(dir, 'default', etat), true);

  const relu = rl.load(dir, 'default');
  assert.strictEqual(relu.lastAttempt, a(8, 0));
  assert.strictEqual(rl.evaluate(relu, null, a(8, 1)).allowed, false);
});

test('chaque compte a son propre budget', (t) => {
  /* Le budget est par COMPTE, pas par instance : c'est le compte que
   * PRONOTE voit. Mais deux comptes distincts ne doivent pas se
   * pénaliser mutuellement. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-rate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  rl.save(dir, 'college', rl.afterAttempt(rl.emptyState(), a(8, 0)));

  assert.strictEqual(rl.evaluate(rl.load(dir, 'college'), null, a(8, 1)).allowed, false);
  assert.strictEqual(rl.evaluate(rl.load(dir, 'lycee'), null, a(8, 1)).allowed, true);
});

test('un état absent ou corrompu ne bloque pas le module', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-rate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.deepStrictEqual(rl.load(dir, 'jamais-vu'), rl.emptyState());
  fs.writeFileSync(rl.stateFile(dir, 'casse'), '{ pas du JSON');
  assert.deepStrictEqual(rl.load(dir, 'casse'), rl.emptyState());
  assert.strictEqual(rl.evaluate(rl.load(dir, 'casse'), null, a(8, 0)).allowed, true);
});

test('une écriture impossible est signalée, pas silencieuse', (t) => {
  /* L'appelant doit pouvoir avertir : sans persistance, le garde-fou ne
   * protège plus du redémarrage en boucle. */
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mmm-rate-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const fichier = path.join(base, 'un-fichier');
  fs.writeFileSync(fichier, 'x');
  assert.strictEqual(rl.save(path.join(fichier, 'sous-dossier'), 'default', rl.emptyState()),
                     false);
});

test('le nom de fichier ne peut pas s\'échapper du dossier', () => {
  const dir = path.join(os.tmpdir(), 'mmm-test');
  for (const hostile of ['../../etc/passwd', 'a/b', '/etc/shadow']) {
    assert.strictEqual(path.dirname(rl.stateFile(dir, hostile)), dir);
  }
});

/* ── Lisibilité des messages ─────────────────────────────────────── */

test('les durées sont lisibles', () => {
  assert.strictEqual(rl.humanize(45000), '45 s');
  assert.strictEqual(rl.humanize(5 * MIN), '5 min');
  assert.strictEqual(rl.humanize(2 * H), '2 h');
  assert.strictEqual(rl.humanize(2 * H + 15 * MIN), '2 h 15');
});

test('chaque blocage porte un message exploitable', () => {
  const cas = [
    Object.assign(rl.emptyState(), { suspendedUntil: a(20, 0), lastAttempt: a(8, 0) }),
    Object.assign(rl.emptyState(), { day: rl.dayKey(a(9, 0)), attemptsToday: 99 }),
    rl.afterOutcome(rl.afterAttempt(rl.emptyState(), a(9, 0)), a(9, 0), { ok: false }),
    rl.afterAttempt(rl.emptyState(), a(9, 0))
  ];
  for (const etat of cas) {
    const v = rl.evaluate(etat, null, a(9, 1));
    assert.strictEqual(v.allowed, false);
    assert.ok(v.message && v.message.length > 20, `message trop court : ${v.message}`);
    assert.ok(v.retryAfterMs > 0, 'un blocage doit dire quand réessayer');
  }
});
