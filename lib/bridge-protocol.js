'use strict';
/* MMM-Pronotepy — module MagicMirror² pour Pronote
 * Copyright (C) 2024-2026 Aldarande
 * Licensed under the MIT License. See LICENSE for details.
 */

/* =====================================================================
   MMM-Pronotepy — lib/bridge-protocol.js
   Le contrat entre Node et pronote_bridge.py, isolé.

   Protocole : une commande JSON sur stdin, une réponse JSON sur stdout.
     {"ok": true,  "data": {...}}
     {"ok": false, "error": "...", "kind": "..."}

   Deux responsabilités, toutes deux pures — donc testables sans lancer
   Python :
     • parseBridgeResponse : décoder stdout et classer l'échec ;
     • messageForKind      : traduire un « kind » en message affichable.
   ===================================================================== */

/* ── Messages d'erreur ────────────────────────────────────────────────
 * Le pont Python classe l'erreur ; à chaque « kind » son message
 * affichable. La distinction bad_pin / qr_expired compte : les deux
 * remontent du même échec de déchiffrement AES, mais l'un met le PIN en
 * cause et l'autre le QR Code. Les confondre envoie l'utilisateur
 * vérifier un PIN pourtant correct.
 *
 * Les quatre derniers « kind » sont produits par Node lui-même
 * (lib/bridge-runner.js) et non par Python : ils décrivent un pont qui
 * n'a pas pu s'exécuter, pas un refus de Pronote. */
const ERROR_MESSAGES = {
  no_tokens:      ()  => 'Aucun jeton configuré. Scannez un QR Code Pronote.',
  bad_pin:        ()  => 'Code PIN incorrect — il doit être celui choisi dans l\'application Pronote.',
  qr_expired:     ()  => 'QR Code expiré ou déjà utilisé. Générez-en un nouveau (validité : 10 minutes).',
  bad_qr:         ()  => 'Contenu du QR Code illisible. Réessayez avec une image plus nette.',
  outdated:       ()  => 'Page de connexion Pronote non reconnue — pronotepy est trop ancien. Lancez « npm run setup ».',
  auth_failed:    ()  => 'Jeton expiré. Rescannez un QR Code Pronote.',
  network:        (e) => `Erreur réseau : ${e.message}`,

  no_python:      ()  => 'Python 3 est introuvable. Lancez « npm run setup » dans le dossier du module, '
                       + 'ou désignez un interpréteur avec l\'option « pythonPath ». '
                       + 'Sous Docker, vérifiez que l\'image contient bien python3 et python3-venv.',
  bridge_missing: ()  => 'Le pont Python est absent du module. Réinstallez MMM-Pronotepy.',
  timeout:        ()  => 'Pronote n\'a pas répondu à temps. Nouvelle tentative au prochain cycle.',
  oversize:       ()  => 'Réponse anormalement volumineuse du pont Python — collecte interrompue.'
};

function messageForKind (kind, err) {
  const build = ERROR_MESSAGES[kind];
  const safe  = err || { message: '' };
  return build ? build(safe) : `Erreur : ${safe.message}`;
}

/* ── Décodage de la réponse ───────────────────────────────────────────
 * `stdout` est le flux complet du pont, `code` son code de sortie et
 * `stderrTail` sa dernière trace — la plus proche de la cause réelle
 * quand le processus meurt sans rien écrire sur stdout.
 *
 * Retourne { ok: true, data } ou { ok: false, error, kind }. On ne lève
 * pas ici : l'appelant décide s'il transforme cela en rejet de promesse,
 * ce qui garde la fonction pure et facile à éprouver. */
function parseBridgeResponse (stdout, code, stderrTail) {
  const raw  = String(stdout == null ? '' : stdout).trim();
  const tail = String(stderrTail == null ? '' : stderrTail).trim();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* Un pont qui sort en 0 sans JSON exploitable est un bug du pont ;
     * un code non nul est presque toujours une exception Python dont la
     * dernière ligne de stderr porte le message utile. */
    return code === 0
      ? { ok: false, kind: 'error',
          error: `Réponse illisible du pont Python : ${raw.slice(0, 200) || '(vide)'}` }
      : { ok: false, kind: 'error',
          error: `Le pont Python a quitté (code ${code}) : ${tail || 'aucune trace'}` };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, kind: 'error',
             error: `Réponse inattendue du pont Python : ${raw.slice(0, 200)}` };
  }

  if (!parsed.ok) {
    return { ok: false,
             kind:  parsed.kind || 'error',
             error: parsed.error || 'Erreur inconnue du pont' };
  }

  /* « ok: true » sans data reste un succès : certaines actions ne
   * renvoient rien d'autre que leur réussite. */
  return { ok: true, data: parsed.data === undefined ? {} : parsed.data };
}

/* Erreur porteuse d'un « kind », seule forme que node_helper sait
 * traduire en message affichable. */
function bridgeError (kind, message) {
  const err = new Error(message);
  err.kind  = kind;
  return err;
}

module.exports = { ERROR_MESSAGES, messageForKind, parseBridgeResponse, bridgeError };
