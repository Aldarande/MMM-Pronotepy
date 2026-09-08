'use strict';
/* MMM-Pronotepy — module MagicMirror² pour Pronote
 * Copyright (C) 2024-2026 Aldarande
 * Licensed under the MIT License. See LICENSE for details.
 */

/* =====================================================================
   MMM-Pronotepy — lib/python.js
   Choix de l'interpréteur Python qui exécutera le pont.

   Quatre sources, de la plus explicite à la plus implicite :

     1. MMM_PRONOTEPY_PYTHON   variable d'environnement
     2. pythonPath             option de config.js
     3. .venv/                 environnement créé par « npm run setup »
     4. python3 / python       interpréteur du système

   Les deux premières existent parce que le venv du module n'est pas
   toujours le bon interpréteur : image Docker sans Python où l'on en
   monte un ailleurs, Python compilé à la main, venv partagé entre
   plusieurs modules. C'est la convention des modules MagicMirror qui
   pilotent du Python — MMM-Face-Reco-DNN expose la même option sous le
   même nom.

   Un réglage explicite est TOUJOURS honoré, même si le fichier est
   absent : retomber silencieusement sur le venv masquerait une faute de
   frappe, et le module se mettrait à interroger Pronote avec un autre
   interpréteur que celui demandé. On avertit, et on laisse l'échec de
   lancement dire la vérité.
   ===================================================================== */

const path = require('path');
const fs   = require('fs');

/* Un réglage vide, « null » ou fait d'espaces vaut « non renseigné » :
 * config.js écrit volontiers `pythonPath: ""` pour dire « laisse faire ». */
function _renseigne (valeur) {
  const texte = typeof valeur === 'string' ? valeur.trim() : '';
  return texte.length > 0 ? texte : null;
}

/* « python3 » se résout via le PATH ; « /usr/bin/python3 » désigne un
 * fichier dont on peut vérifier l'existence. On ne teste que le second :
 * chercher un exécutable dans le PATH depuis Node demanderait de
 * réimplémenter les règles du système (PATHEXT sous Windows, etc.). */
function _estUnChemin (valeur) {
  return valeur.includes('/') || valeur.includes('\\');
}

function _venvCandidates (venvDir) {
  if (!venvDir) return [];
  return [
    path.join(venvDir, 'bin', 'python'),          // venv POSIX
    path.join(venvDir, 'Scripts', 'python.exe')   // venv Windows
  ];
}

/**
 * @param {object}    opts
 * @param {string}   [opts.fromEnv]    valeur de MMM_PRONOTEPY_PYTHON
 * @param {string}   [opts.configured] option `pythonPath` de config.js
 * @param {string}   [opts.venvDir]    dossier .venv du module
 * @param {string}   [opts.platform]   défaut : process.platform
 * @param {function} [opts.exists]     défaut : fs.existsSync (injecté par les tests)
 * @returns {{command: string, source: string, message: string, level: string}}
 *   `source` vaut 'env', 'config', 'venv' ou 'system'.
 */
function resolvePython (opts) {
  const options  = opts || {};
  const exists   = typeof options.exists === 'function' ? options.exists : fs.existsSync;
  const platform = options.platform || process.platform;

  /* 1 & 2 — réglages explicites. */
  const explicites = [
    { valeur: _renseigne(options.fromEnv),    source: 'env',
      origine: 'la variable MMM_PRONOTEPY_PYTHON' },
    { valeur: _renseigne(options.configured), source: 'config',
      origine: 'l\'option « pythonPath » de config.js' }
  ];

  for (const reglage of explicites) {
    if (!reglage.valeur) continue;

    if (_estUnChemin(reglage.valeur) && !exists(reglage.valeur)) {
      return {
        command: reglage.valeur,
        source:  reglage.source,
        level:   'warn',
        message: `Python : « ${reglage.valeur} » (${reglage.origine}) est introuvable. ` +
                 'Le lancement du pont échouera — corrigez le chemin, ou retirez le ' +
                 'réglage pour laisser le module utiliser son venv.'
      };
    }
    return {
      command: reglage.valeur,
      source:  reglage.source,
      level:   'info',
      message: `Python : ${reglage.valeur} (${reglage.origine})`
    };
  }

  /* 3 — le venv du module, cas nominal après « npm run setup ». */
  for (const candidat of _venvCandidates(options.venvDir)) {
    if (exists(candidat)) {
      return {
        command: candidat,
        source:  'venv',
        level:   'info',
        message: `Python (venv) : ${candidat}`
      };
    }
  }

  /* 4 — repli sur le système. Il n'a aucune raison d'avoir pronotepy :
   * l'avertissement doit donc être franc, c'est le scénario où la
   * collecte échouera d'un « ImportError » quelques secondes plus tard. */
  const systeme = platform === 'win32' ? 'python' : 'python3';
  return {
    command: systeme,
    source:  'system',
    level:   'warn',
    message: `Aucun venv dans ${options.venvDir || '(non précisé)'} — repli sur « ${systeme} ». ` +
             'Lancez « npm run setup », ou désignez un interpréteur avec l\'option ' +
             '« pythonPath ». Sous Docker, l\'image peut ne pas contenir Python du tout.'
  };
}

module.exports = { resolvePython };
