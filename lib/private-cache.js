'use strict';
/* MMM-Pronotepy — module MagicMirror² pour Pronote
 * Copyright (C) 2024-2026 Aldarande
 * Licensed under the MIT License. See LICENSE for details.
 */

/* =====================================================================
   MMM-Pronotepy — lib/private-cache.js
   Sortir les jetons de la portée du serveur web.

   LE DÉFAUT, constaté en production le 2026-09-15 :

     GET http://<miroir>:8080/modules/MMM-Pronotepy/cache/tokens-default.json
     → 200, avec l'URL Pronote, l'identifiant, les prénoms des enfants et
       les jetons de reconnexion.

   MagicMirror sert TOUT le dossier `modules/` en statique (js/server.js :
   `app.use("/modules", express.static(...))`). Le cache du module y vit,
   donc il était téléchargeable par quiconque atteint le port 8080.

   L'authentification des routes n'y changeait rien : elle protège
   `/MMM-Pronotepy/*`, les fichiers sont servis depuis `/modules/...`.
   Deux chemins distincts, deux mécanismes distincts.

   Et on ne peut pas la rattraper par une route : les middlewares
   statiques sont enregistrés dans server.js AVANT que les helpers ne
   reçoivent `expressApp`. Tout `app.use()` posé par le module arrive
   après dans la chaîne — le statique répond le premier.

   LA CORRECTION : un dossier commençant par un point. `express.static`
   ignore les fichiers cachés (vérifié : 404 sur `.x/test.json`, 200 sur
   un fichier ordinaire du même dossier). Le cache reste donc dans le
   dossier du module — donc dans le bind mount d'une installation Docker,
   donc il survit à une recréation du conteneur — tout en sortant de la
   portée du serveur web.

   Déplacer le cache hors de `modules/` aurait été plus intuitif, mais
   sous Docker seuls `config/` et `modules/` sont montés — et `config/`
   est servi en statique lui aussi. Tout emplacement persistant est
   exposé ; seul le point le soustrait.
   ===================================================================== */

const fs   = require('fs');
const path = require('path');

/* Le point est ce qui protège : ne pas le retirer. */
const PRIVATE_DIR = '.cache';
const LEGACY_DIR  = 'cache';

function privateCacheDir (moduleDir) {
  return path.join(moduleDir, PRIVATE_DIR);
}

function legacyCacheDir (moduleDir) {
  return path.join(moduleDir, LEGACY_DIR);
}

/* ── Reprise de l'ancien dossier ──────────────────────────────────────
 * Une installation existante a ses jetons dans `cache/`. Les y laisser
 * maintiendrait l'exposition ; obliger à rescanner un QR Code pour un
 * défaut qui n'est pas celui de l'utilisateur serait pire.
 *
 * On déplace donc le contenu, une fois, au démarrage. Fichier par
 * fichier plutôt qu'un rename du dossier : sous Docker le bind mount
 * peut refuser de renommer un répertoire, et un échec partiel doit
 * laisser les deux côtés lisibles plutôt qu'un dossier à moitié déplacé.
 */
function migrateLegacyCache (moduleDir) {
  const ancien = legacyCacheDir(moduleDir);
  const neuf   = privateCacheDir(moduleDir);

  if (!fs.existsSync(ancien)) return { migrated: false, reason: 'absent', moved: [] };

  let entrees;
  try { entrees = fs.readdirSync(ancien); }
  catch (e) { return { migrated: false, reason: 'failed', error: e.message, moved: [] }; }

  const moved   = [];
  const restants = [];
  try { fs.mkdirSync(neuf, { recursive: true }); }
  catch (e) { return { migrated: false, reason: 'failed', error: e.message, moved: [] }; }

  for (const nom of entrees) {
    const de = path.join(ancien, nom);
    const a  = path.join(neuf, nom);
    try {
      /* Ne jamais écraser : si le fichier existe déjà côté privé, c'est
       * lui qui fait foi — il est plus récent par construction. */
      if (fs.existsSync(a)) { fs.unlinkSync(de); continue; }
      fs.renameSync(de, a);
      moved.push(nom);
    } catch {
      restants.push(nom);
    }
  }

  /* Le dossier exposé ne doit pas subsister : vide, il ne révèle rien,
   * mais le laisser inviterait à y réécrire. */
  if (restants.length === 0) {
    try { fs.rmdirSync(ancien); } catch { /* pas vide, ou verrouillé */ }
  }

  return {
    migrated: moved.length > 0,
    reason:   restants.length ? 'partial' : 'ok',
    moved,
    restants
  };
}

/** Le dossier privé, créé au besoin, après reprise de l'ancien. */
function ensurePrivateCache (moduleDir) {
  const bilan = migrateLegacyCache(moduleDir);
  const dir   = privateCacheDir(moduleDir);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* signalé à l'usage */ }
  return { dir, bilan };
}

module.exports = {
  privateCacheDir, legacyCacheDir, migrateLegacyCache, ensurePrivateCache,
  PRIVATE_DIR, LEGACY_DIR
};
