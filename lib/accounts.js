'use strict';
/* MMM-Pronotepy — module MagicMirror² pour Pronote
 * Copyright (C) 2024-2026 Aldarande
 * Licensed under the MIT License. See LICENSE for details.
 */

/* =====================================================================
   MMM-Pronotepy — lib/accounts.js
   Plusieurs comptes Pronote sur un même miroir.

   POURQUOI : un compte parent ne couvre pas toujours toute la fratrie.
   Un enfant peut être rattaché à un compte parent d'un établissement,
   un autre à un compte parent d'un second établissement, un troisième
   avoir son propre compte élève. Ce sont des JETONS distincts, pas des
   enfants d'un même compte — ce que `childName` ne peut pas exprimer.

   MODÈLE : un « compte » est une étiquette libre choisie dans
   config.js, à laquelle correspond un fichier de jetons.

     account: "college-alice"  →  cache/tokens-college-alice.json
     account: "lycee-hugo"     →  cache/tokens-lycee-hugo.json

   `account` et `childName` se combinent : deux instances peuvent
   partager un compte parent et n'en afficher qu'un enfant chacune.

   NORMALISATION : elle a lieu ICI, et nulle part ailleurs. Le pont
   Python reçoit une étiquette déjà réduite à [a-z0-9-] et se contente
   de la VALIDER avant d'en faire un chemin. Deux implémentations d'une
   même règle de nommage finiraient par diverger, et la divergence se
   verrait le jour où un jeton serait cherché au mauvais endroit.
   ===================================================================== */

const fs   = require('fs');
const path = require('path');

/* Nom du compte quand config.js n'en donne pas. Correspond aussi au
 * fichier historique `tokens.json`, repris à la première occasion. */
const DEFAULT_ACCOUNT = 'default';

const PREFIX = 'tokens-';
const SUFFIX = '.json';

/* Fichier de l'époque « un seul compte ». Il existe sur toute
 * installation antérieure à cette évolution. */
const LEGACY_FILE = 'tokens.json';

/** Étiquette libre → clé sûre. Toujours non vide. */
function normalize (account) {
  const nettoye = String(account === undefined || account === null ? '' : account)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return nettoye || DEFAULT_ACCOUNT;
}

/** La forme que le pont Python accepte. Doit rester en phase avec sa
 *  propre validation (`_account_file` dans pronote_bridge.py). */
function isSafeKey (key) {
  return typeof key === 'string' && /^[a-z0-9-]{1,48}$/.test(key);
}

function tokenFile (cacheDir, account) {
  return path.join(cacheDir, `${PREFIX}${normalize(account)}${SUFFIX}`);
}

/* ── Reprise du fichier historique ────────────────────────────────────
 * Une installation existante a un `tokens.json` et un compte qui marche.
 * Le renommer une fois pour toutes évite d'avoir à traiter deux
 * emplacements pour toujours — et surtout évite qu'un utilisateur ait à
 * rescanner un QR Code pour une évolution qui ne le concerne pas.
 *
 * Idempotent, et prudent : si les deux fichiers existent, on ne touche à
 * rien et on le signale. Écraser un fichier de jetons valide coûterait
 * un rescan, ce qui est exactement ce qu'on cherche à éviter. */
function migrateLegacy (cacheDir) {
  const ancien = path.join(cacheDir, LEGACY_FILE);
  const neuf   = tokenFile(cacheDir, DEFAULT_ACCOUNT);

  if (!fs.existsSync(ancien)) return { migrated: false, reason: 'absent' };
  if (fs.existsSync(neuf))    return { migrated: false, reason: 'conflict', from: ancien, to: neuf };

  try {
    fs.renameSync(ancien, neuf);
    return { migrated: true, reason: 'ok', from: ancien, to: neuf };
  } catch (e) {
    return { migrated: false, reason: 'failed', error: e.message };
  }
}

/* ── Comptes présents sur le disque ─────────────────────────────────
 * Sert à la page de configuration : elle doit pouvoir proposer les
 * comptes déjà connus plutôt que d'attendre qu'on retape l'étiquette. */
function listStored (cacheDir) {
  try {
    return fs.readdirSync(cacheDir)
      .filter(f => f.startsWith(PREFIX) && f.endsWith(SUFFIX))
      .map(f => f.slice(PREFIX.length, -SUFFIX.length))
      .filter(isSafeKey)
      .sort();
  } catch {
    return [];                            // dossier absent : aucun compte
  }
}

/** Lecture tolérante d'un fichier de jetons. */
function loadTokens (cacheDir, account) {
  try {
    const brut = fs.readFileSync(tokenFile(cacheDir, account), 'utf8');
    const lu   = JSON.parse(brut);
    return lu && typeof lu === 'object' ? lu : null;
  } catch {
    return null;
  }
}

function removeTokens (cacheDir, account) {
  const fichier = tokenFile(cacheDir, account);
  try {
    if (!fs.existsSync(fichier)) return false;
    fs.unlinkSync(fichier);
    return true;
  } catch {
    return false;
  }
}

/* Clé du cache hors ligne : un compte et un enfant. Deux comptes
 * peuvent parfaitement avoir chacun une « Hugo ». */
function offlineKey (account, childName) {
  const enfant = String(childName || '').trim();
  return enfant ? `${normalize(account)}-${enfant}` : normalize(account);
}

module.exports = {
  normalize, isSafeKey, tokenFile, migrateLegacy, listStored,
  loadTokens, removeTokens, offlineKey,
  DEFAULT_ACCOUNT, LEGACY_FILE
};
