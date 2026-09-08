#!/usr/bin/env node
/* MMM-Pronotepy — module MagicMirror² pour Pronote
 * Copyright (C) 2024-2026 Aldarande
 * Licensed under the MIT License. See LICENSE for details.
 */
'use strict';

/* =====================================================================
   MMM-Pronotepy — postinstall.js
   Crée l'environnement virtuel Python et y installe pronotepy,
   puis affiche les étapes de configuration.

   Un échec ici n'interrompt jamais `npm install` : le module affiche
   de toute façon un message explicite si le pont Python est absent.
   ===================================================================== */

const { spawnSync } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs   = require('fs');

/* Proposée dans les consignes de fin d'installation : sans clé, les routes
 * HTTP du module ne répondent qu'en local, et la page de configuration —
 * qu'on ouvre justement depuis un téléphone — devient inaccessible. Une clé
 * toute prête évite qu'on renonce à en mettre une. */
const apiKeySuggeree = crypto.randomBytes(24).toString('hex');

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  green:  '\x1b[32m',
  cyan:   '\x1b[36m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  white:  '\x1b[97m',
  dim:    '\x1b[2m',
};

const line  = `${c.dim}${'─'.repeat(60)}${c.reset}`;
const blank = '';
const isWin = process.platform === 'win32';

const VENV_DIR    = path.join(__dirname, '.venv');
const VENV_PYTHON = isWin
  ? path.join(VENV_DIR, 'Scripts', 'python.exe')
  : path.join(VENV_DIR, 'bin', 'python');
const REQUIREMENTS = path.join(__dirname, 'requirements.txt');

/* ── Recherche d'un interpréteur Python 3 utilisable ─────────────── */
function findSystemPython () {
  for (const bin of isWin ? ['python', 'py', 'python3'] : ['python3', 'python']) {
    const probe = spawnSync(bin, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (probe.status === 0 && (probe.stdout || '').trim() === '3') return bin;
  }
  return null;
}

/* ── Installation des dépendances Python ─────────────────────────── */
function setupPython () {
  if (!fs.existsSync(REQUIREMENTS)) {
    console.log(`${c.yellow}  ⚠  requirements.txt introuvable — installation Python ignorée.${c.reset}`);
    return false;
  }

  if (!fs.existsSync(VENV_PYTHON)) {
    const python = findSystemPython();
    if (!python) {
      console.log(`${c.red}  ✖  Python 3 introuvable.${c.reset}`);
      console.log(`     Installez-le puis relancez : ${c.bold}npm run setup${c.reset}`);
      console.log(`     Sur Debian/Raspberry Pi : ${c.dim}sudo apt install python3 python3-venv${c.reset}`);
      return false;
    }

    console.log(`${c.dim}  Création de l'environnement virtuel (.venv)…${c.reset}`);
    const venv = spawnSync(python, ['-m', 'venv', VENV_DIR], { stdio: 'inherit' });
    if (venv.status !== 0 || !fs.existsSync(VENV_PYTHON)) {
      console.log(`${c.red}  ✖  Échec de création du venv.${c.reset}`);
      console.log(`     Sur Debian/Raspberry Pi : ${c.dim}sudo apt install python3-venv${c.reset}`);
      return false;
    }
  }

  console.log(`${c.dim}  Installation de pronotepy…${c.reset}`);
  const pip = spawnSync(
    VENV_PYTHON,
    ['-m', 'pip', 'install', '--upgrade', '--disable-pip-version-check', '-r', REQUIREMENTS],
    { stdio: 'inherit' }
  );
  if (pip.status !== 0) {
    console.log(`${c.red}  ✖  Échec de l'installation de pronotepy.${c.reset}`);
    console.log(`     Relancez manuellement : ${c.bold}npm run setup${c.reset}`);
    return false;
  }

  const version = spawnSync(
    VENV_PYTHON,
    ['-c', 'import pronotepy; print(pronotepy.__version__)'],
    { encoding: 'utf8' }
  );
  const label = version.status === 0 ? (version.stdout || '').trim() : 'installé';
  console.log(`${c.green}  ✔  pronotepy ${label}${c.reset}`);
  return true;
}

/* ── Déroulé ─────────────────────────────────────────────────────── */
console.log(blank);
console.log(line);
console.log(`${c.bold}${c.white}  MMM-Pronotepy — installation${c.reset}`);
console.log(line);
console.log(blank);

const ok = setupPython();

console.log(blank);
console.log(line);
console.log(ok
  ? `${c.bold}${c.green}  ✅  MMM-Pronotepy installé avec succès !${c.reset}`
  : `${c.bold}${c.yellow}  ⚠  Installation incomplète — voir les messages ci-dessus.${c.reset}`);
console.log(line);
console.log(blank);
console.log(`${c.bold}${c.white}  Pour terminer la configuration :${c.reset}`);
console.log(blank);
console.log(`  ${c.cyan}${c.bold}Étape 1${c.reset} — Ajoutez le module dans votre ${c.yellow}config/config.js${c.reset} :`);
console.log(blank);
console.log(`  ${c.dim}    {`);
console.log(`  ${c.dim}      module: "MMM-Pronotepy",`);
console.log(`  ${c.dim}      position: "bottom_left",`);
console.log(`  ${c.dim}      config: {`);
console.log(`  ${c.dim}        apiKey: "${apiKeySuggeree}"`);
console.log(`  ${c.dim}      }`);
console.log(`  ${c.dim}    }${c.reset}`);
console.log(blank);
console.log(`  ${c.dim}  La clé ci-dessus est générée pour vous. Sans elle, la page de`);
console.log(`  ${c.dim}  configuration n'est joignable que depuis le miroir lui-même.${c.reset}`);
console.log(blank);
console.log(`  ${c.cyan}${c.bold}Étape 2${c.reset} — Redémarrez MagicMirror :`);
console.log(blank);
console.log(`  ${c.dim}    docker restart magic-mirror${c.reset}`);
console.log(blank);
console.log(`  ${c.cyan}${c.bold}Étape 3${c.reset} — Ouvrez la page de configuration :`);
console.log(blank);
console.log(`  ${c.bold}${c.yellow}    http://<IP-de-votre-MagicMirror>:8080/MMM-Pronotepy/config${c.reset}`);
console.log(blank);
console.log(line);
console.log(blank);
