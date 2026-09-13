# MMM-Pronotepy

> Module [MagicMirror²](https://magicmirror.builders/) pour afficher les données scolaires **Pronote** via la bibliothèque **[pronotepy](https://github.com/bain3/pronotepy)**.

Le module est en deux morceaux : un **pont Python** (`pronote_bridge.py`) qui parle à Pronote avec pronotepy et détient les jetons, et un **backend Node** (`node_helper.js`) qui l'appelle, met en forme les dates dans la langue de MagicMirror et sert la page de configuration.

---

## Sommaire

- [Fonctionnalités](#fonctionnalités)
- [Prérequis](#prérequis)
  - [Sous Docker : vérifiez que l'image contient Python](#sous-docker--vérifiez-que-limage-contient-python)
- [Installation](#installation)
  - [Installation sous Docker](#installation-sous-docker)
- [Interpréteur Python](#interpréteur-python)
- [Hors ligne](#hors-ligne)
- [Plusieurs comptes Pronote](#plusieurs-comptes-pronote)
- [Fenêtre de nuit](#fenêtre-de-nuit)
- [Ne pas se faire suspendre par PRONOTE](#ne-pas-se-faire-suspendre-par-pronote)
- [Sécurité — clé d'API](#sécurité--clé-dapi)
- [Première connexion](#première-connexion)
  - [Connexion par QR Code](#connexion-par-qr-code)
  - [Compte parent](#compte-parent)
- [Configuration complète](#configuration-complète)
  - [Référence de toutes les options](#référence-de-toutes-les-options)
  - [Plages horaires d'affichage](#plages-horaires-daffichage)
  - [Exemples de configurations](#exemples-de-configurations)
- [Système de tokens](#système-de-tokens)
- [Page de configuration](#page-de-configuration)
- [Dépannage](#dépannage)
- [Structure des fichiers](#structure-des-fichiers)
- [Tests](#tests)
- [Licence](#licence)
- [Crédits](#crédits)

---

## Fonctionnalités

| Section | Ce qui est affiché |
|---|---|
| 📅 **Emploi du temps** | Cours du jour restants + prochain cours (jour, heure, matière) si aucun cours aujourd'hui |
| 📝 **Devoirs** | Liste groupée par date limite, avec statut fait/à faire |
| 📊 **Notes** | Dernières notes avec barème, moyenne de classe et coefficient |
| 🚫 **Absences** | Absences justifiées / non justifiées avec motif |
| ⏱ **Retards** | Retards avec durée et motif |
| ⚖ **Punitions** | Punitions avec type et motif |
| ⏰ **Plages horaires** | Chaque section peut être masquée selon l'heure (`showFrom` / `showUntil`) |
| 👨‍👩‍👧 **Multi-comptes** | Élève ou parent — sélection automatique de l'enfant à la configuration |
| 🔐 **QR Code seul** | Aucun mot de passe demandé ni stocké ; jeton persisté à chaque authentification |
| 🛟 **Appareil de secours** | Second appareil enregistré au scan, promu automatiquement si le principal tombe |
| ⚙ **Page de config** | Interface web avec statut d'authentification en direct et exemple de config généré |

---

## Prérequis

| Logiciel | Version minimale |
|---|---|
| [MagicMirror²](https://magicmirror.builders/) | 2.13.0 |
| Node.js | 18.x |
| npm | 8.x |
| Python | 3.8 |
| `python3-venv` | — |
| pronotepy | 2.15.7 |

> Le plancher pronotepy n'est pas décoratif : les serveurs PRONOTE 2026 ne publient plus l'appel `Start({...})` dans l'attribut `onload` du `<body>`, ce sur quoi les versions ≤ 2.14.6 échouent avec un `KeyError: 'onload'`. Si le module affiche *« Page de connexion Pronote non reconnue »*, relancez `npm run setup`.

Sur Debian / Raspberry Pi, si `python3-venv` manque :

```bash
sudo apt install python3 python3-venv
```

> `python3` seul ne suffit pas : sans `python3-venv`, la création de
> l'environnement échoue sur *« ensurepip is not available »*.

### Sous Docker : vérifiez que l'image contient Python

C'est le piège le plus courant, et il est invisible. Les images
`karsten13/magicmirror` n'installent `python3` **que dans la variante
`electron`** — le `Dockerfile` du projet le conditionne explicitement :

```bash
if [[ "${ARTIFACT}" == "electron" ]]; then
  _pck="${_pck} … procps arp-scan python3"
fi
```

Or le tag `latest` ne désigne pas la même chose selon l'architecture :

| Architecture | Ce que `latest` résout | Python |
|---|---|---|
| amd64 (PC, Docker Desktop) | `debian-server` | ❌ absent |
| arm64 / arm (Raspberry Pi) | `debian-electron` | ⚠️ `python3` seul, sans `python3-venv` |

Autrement dit : sur PC, l'image n'a **aucun** Python ; sur Raspberry Pi,
elle en a un mais `npm run setup` échouera quand même faute de
`python3-venv`. Le tag `fat`, qui existait pour ce cas, s'arrête à la
v2.36.0 (30/06/2026) et n'est plus reconstruit — ne comptez pas dessus.

Vérifiez avant d'installer :

```bash
docker exec magic-mirror sh -lc "python3 --version && python3 -m venv /tmp/probe && echo OK"
```

Si cela échoue, deux solutions. **Étendre l'image** (durable) — un
`Dockerfile` à côté de votre `docker-compose.yml` :

```dockerfile
FROM karsten13/magicmirror:latest
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*
USER node
```

puis `build: .` à la place de `image:` dans le compose. Ou bien
**désigner un Python existant ailleurs** avec l'option `pythonPath` /
la variable `MMM_PRONOTEPY_PYTHON` — voir la section suivante.

---

## Installation

### 1. Récupérer le module

```bash
cd ~/MagicMirror/modules
git clone https://github.com/Aldarande/MMM-Pronotepy.git
```

### 2. Installer les dépendances

```bash
cd ~/MagicMirror/modules/MMM-Pronotepy
npm install
```

Le module n'a **aucune dépendance npm**. `npm install` sert uniquement à
déclencher `postinstall.js`, qui crée un environnement virtuel Python dans
`.venv/` et y installe **pronotepy**.

Si cette étape échoue — Python absent, `python3-venv` manquant — le reste de
l'installation se poursuit et vous pouvez la relancer seule :

```bash
npm run setup
```

Vérifiez que pronotepy est bien en place :

```bash
.venv/bin/python -c "import pronotepy; print(pronotepy.__version__)"
```

### 3. Déclarer le module dans `config.js`

Ouvrez `~/MagicMirror/config/config.js` et ajoutez ce bloc au tableau `modules` :

```javascript
{
  module: "MMM-Pronotepy",
  position: "top_left",
  config: {
    updateInterval: "60m"
  }
}
```

C'est la configuration minimale : toutes les autres options ont des valeurs par
défaut utilisables telles quelles. Voir [Référence de toutes les
options](#référence-de-toutes-les-options) pour la suite.

### 4. Redémarrer MagicMirror

```bash
pm2 restart MagicMirror
```

Ou, sans pm2, en relançant `npm start` depuis le dossier de MagicMirror.

Le module affiche alors un écran de chargement avec le logo Pronote : il n'a pas
encore de jeton. Passez à la [première connexion](#première-connexion).

---

### Installation sous Docker

Le principe est le même, avec une contrainte : **l'environnement virtuel doit
être créé dans le conteneur**, car il contient des binaires Linux. Un `.venv`
construit depuis l'hôte — sous Windows en particulier — serait inutilisable.

Vérifiez d'abord que l'image contient Python : voir [Sous Docker : vérifiez que
l'image contient Python](#sous-docker--vérifiez-que-limage-contient-python).
L'image `karsten13/magicmirror:latest` n'en a pas sur PC.

Clonez côté hôte, dans le dossier `modules` monté dans le conteneur :

```bash
git clone https://github.com/Aldarande/MMM-Pronotepy.git
```

Puis installez **depuis le conteneur** :

```bash
docker exec -w /opt/magic_mirror/modules/MMM-Pronotepy magic-mirror npm install
```

Déclarez le module dans `config.js` comme ci-dessus, puis redémarrez :

```bash
docker restart magic-mirror
```

Contrôlez que tout est en place — vous devez lire `Node helper started` puis la
ligne indiquant l'interpréteur retenu :

```bash
docker logs --tail 50 magic-mirror 2>&1 | grep MMM-Pronotepy
```

Remplacez `magic-mirror` par le nom de votre conteneur et
`/opt/magic_mirror/modules` par le chemin des modules dans votre image.

---

## Interpréteur Python

Le module exécute son pont avec le premier interpréteur trouvé, dans cet
ordre :

| Priorité | Source | Usage |
|---|---|---|
| 1 | `MMM_PRONOTEPY_PYTHON` | variable d'environnement — pratique en Docker, où l'on sait où Python a été installé |
| 2 | `pythonPath` | option de `config.js` |
| 3 | `.venv/` | l'environnement créé par `npm run setup` — le cas normal |
| 4 | `python3` / `python` | repli sur le système, **sans pronotepy** : la collecte échouera |

Dans le cas normal, il n'y a rien à régler : `npm run setup` crée `.venv`
et le module le trouve. Les deux premières entrées servent quand Python
vit ailleurs — venv partagé entre plusieurs modules, Python compilé à la
main, interpréteur monté dans un conteneur.

```js
config: {
  pythonPath: "/opt/python-partage/bin/python3"
}
```

```bash
# ou, au niveau du conteneur
MMM_PRONOTEPY_PYTHON=/usr/local/bin/python3.13
```

Un chemin explicite est **toujours** honoré, même s'il n'existe pas : le
module avertit dans les logs plutôt que de retomber silencieusement sur
le venv, ce qui masquerait une faute de frappe. La ligne de log au
démarrage indique toujours l'interpréteur retenu et sa provenance.

---

## Hors ligne

Une coupure réseau ne vide plus l'écran. À chaque collecte réussie, la charge
utile est archivée dans `cache/last-<enfant>.json` ; en cas d'échec, le module
la rejoue au lieu de basculer sur la page d'erreur, avec un bandeau qui indique
l'heure de la collecte.

```
● HORS LIGNE · DONNÉES DE 07:42
```

### Le cache ne franchit jamais minuit

C'est la règle qui prime sur toutes les autres, et **aucun réglage ne peut
l'assouplir**.

La charge utile est relative au jour : `timetableToday` ne veut pas dire « ces
cours-là » mais « les cours d'aujourd'hui ». Rejouer le cache de la veille
afficherait donc l'emploi du temps d'hier comme étant celui du jour — un enfant
partirait avec le mauvais cartable. Ici, une donnée périmée est **pire** qu'une
absence de donnée : passé minuit, on revient à l'écran d'erreur, qui a le mérite
de ne rien affirmer de faux.

### Réglage

```js
config: {
  offlineMaxAge: "6h"   // défaut ; "0", null ou false désactivent le repli
}
```

Six heures par défaut : de quoi couvrir une box en panne toute une matinée. Une
valeur non reconnue vaut désactivation — contrairement à `updateInterval`, qui
retombe sur son défaut, mieux vaut ici ne rien afficher que de deviner.

| Situation | Ce qui s'affiche |
|---|---|
| Collecte réussie | les données, sans bandeau |
| Échec, cache du jour et dans la fenêtre | les données + bandeau « hors ligne » |
| Échec, cache de la veille | écran d'erreur |
| Échec, cache plus vieux que `offlineMaxAge` | écran d'erreur |
| Échec, aucun cache | écran d'erreur |

Le fichier contient les notes, absences et punitions : il est écrit en `0600`,
comme le fichier de jetons. Une écriture impossible n'interrompt jamais une
collecte par ailleurs réussie — le cache est un confort, pas une dépendance.

### Usure de la carte SD

MagicMirror tourne le plus souvent sur un Raspberry Pi, donc sur une carte SD
dont l'endurance se compte en cycles d'effacement. Ce que le module écrit :

| Fichier | Taille | Quand |
|---|---|---|
| `cache/tokens.json` | ~800 o | à chaque authentification réussie |
| `cache/last-<enfant>.json` | ~2 Ko | à chaque collecte, **si le contenu a changé** |
| `cache/device_uuid.txt` | 30 o | une seule fois |

Deux économies sont en place :

- **Le cache hors ligne n'est pas réécrit à l'identique.** Les nuits, les
  week-ends et les vacances produisent exactement la même charge utile d'un
  cycle à l'autre : la relire pour comparer ne coûte rien, la réécrire use la
  carte pour rien. Un contenu figé coûte au plus **une écriture par heure** —
  l'horodatage est tout de même rafraîchi, sans quoi le cache serait jugé
  périmé alors qu'il vient d'être confirmé.
- **Le jeton n'est pas réécrit s'il est identique.** PRONOTE le renouvelle à
  chaque authentification, donc le cas est rare — c'est un garde-fou.

Le point qui compte vraiment n'est pas la taille mais **le nombre
d'authentifications** : pronotepy se ré-authentifie à chaque requête refusée, et
un cycle peut en compter plusieurs dizaines, chacune écrivant un jeton avec
`fsync`. C'est précisément ce que supprime le correctif « onglets non
accessibles » de `pronote_compat.py` — il a été écrit pour éviter une suspension
d'adresse IP, et il réduit l'usure de la carte par la même occasion. Si vous le
retirez un jour, les deux problèmes reviennent ensemble.

En ordre de grandeur, à `updateInterval: "60m"`, le module écrit quelques
dizaines de kilo-octets par jour : plusieurs décennies d'endurance sur une
carte correcte. **Il n'est pas ce qui tuera votre carte.** Sur un miroir, les
vrais consommateurs sont ailleurs :

```bash
# Journal système en mémoire vive plutôt que sur la carte
sudo sed -i 's/^#\?Storage=.*/Storage=volatile/' /etc/systemd/journald.conf
sudo systemctl restart systemd-journald

# Cache du navigateur en tmpfs (MagicMirror en mode Electron)
# à ajouter dans /etc/fstab :
#   tmpfs /home/pi/.cache tmpfs defaults,noatime,size=100M 0 0

# Et surtout : pas de swap sur la carte
sudo dphys-swapfile swapoff && sudo systemctl disable dphys-swapfile
```

Si vous voulez encore réduire la part du module : la [fenêtre de
nuit](#fenêtre-de-nuit) supprime déjà 11 collectes par jour sur 24, et allonger
`updateInterval` — `"2h"`, `"4h"` — divise le reste d'autant. Un emploi du temps
publié la veille au soir ne bouge plus de la journée.

---

## Plusieurs comptes Pronote

Un compte parent ne couvre pas toujours toute la fratrie. Un enfant peut
dépendre d'un autre établissement, ou avoir son propre compte élève. Ce sont des
**jetons distincts**, ce que `childName` ne peut pas exprimer.

Le module gère donc plusieurs comptes, chacun avec son jeu de jetons :

```
account: "college-alice"  →  cache/tokens-college-alice.json
account: "lycee-hugo"     →  cache/tokens-lycee-hugo.json
```

### `account` et `childName` ne font pas la même chose

| | Sépare | Exemple |
|---|---|---|
| `account` | des **comptes Pronote** — des jetons différents | deux établissements, un compte élève |
| `childName` | des **enfants d'un même compte parent** | Hugo et Alice sur le compte du collège |

Les deux se combinent. Deux instances peuvent partager un compte parent et
n'afficher qu'un enfant chacune.

### Exemple : deux établissements

```js
{
  module: "MMM-Pronotepy",
  position: "bottom_left",
  config: {
    account:   "college-alice",
    childName: "Alice"
  }
},
{
  module: "MMM-Pronotepy",
  position: "bottom_right",
  config: {
    account:   "lycee-hugo",
    childName: null            // compte élève : pas d'enfant à choisir
  }
}
```

### Configurer chaque compte

La page de configuration porte un **sélecteur de compte** en haut de la carte
« Statut ». Tout ce qu'elle affiche et fait — statut, scan du QR Code,
suppression des jetons — porte sur le compte sélectionné, et sur lui seul.

Pour ajouter un compte : « + Nouveau », saisissez l'étiquette, puis scannez le
QR Code de ce compte-là. L'étiquette est libre ; elle est réduite en interne à
`[a-z0-9-]` (« Collège Alice » devient `college-alice`).

Supprimer les jetons d'un compte ne touche pas les autres.

### Migration depuis une version à compte unique

**Rien à faire.** Au premier démarrage, `cache/tokens.json` est renommé en
`cache/tokens-default.json` et devient le compte `default` — celui qu'utilisent
les instances sans `account`. Votre configuration existante continue de
fonctionner sans rescan.

Si les deux fichiers coexistent déjà, aucun n'est touché et un avertissement le
signale : écraser un fichier de jetons valide coûterait précisément le rescan
que cette reprise cherche à éviter.

---

## Fenêtre de nuit

Par défaut, les mises à jour périodiques sont suspendues **de 20 h à 7 h**.

```js
config: {
  quietHours: { from: "20:00", until: "07:00" }   // défaut
}
```

Trois raisons, toutes mesurables :

- **PRONOTE** — un tiers des authentifications en moins. C'est leur
  accumulation qui a déjà valu une suspension d'adresse IP ; chaque cycle évité
  est un risque en moins.
- **Carte SD** — autant d'écritures de jeton en moins, chacune `fsync`ée.
- **Rien à gagner** — un emploi du temps ne change pas à 3 h du matin.

À l'intervalle par défaut de 60 min, la fenêtre supprime **11 collectes par
jour** sur 24 : il en reste 13, entre 07:00 et 20:00.

### Ce que la fenêtre ne fait pas

Elle n'a **aucun rapport avec `showFrom` / `showUntil`**, qui masquent des
sections à l'écran. Ici seule la *collecte* s'arrête : ce qui est affiché le
reste, simplement il n'est plus rafraîchi.

Et **la collecte au démarrage a lieu quoi qu'il arrive**, même en pleine
fenêtre. Un miroir redémarré à 23 h resterait sinon vide jusqu'au matin : la
pause vise le sondage périodique, pas l'amorçage.

### Réglages

| Valeur | Effet |
|---|---|
| `{ from: "20:00", until: "07:00" }` | défaut |
| `{ from: "22:30", until: "06:00" }` | fenêtre plus courte |
| `{ from: "09:00", until: "17:00" }` | fenêtre qui ne franchit pas minuit — accepté |
| `null`, `false`, `{ enabled: false }` | pas de pause |

Les horaires s'écrivent `HH:MM` ; `7:00` et `20h00` sont acceptés aussi.

**En cas de doute, la pause est désactivée** — jamais l'inverse. Un horaire
illisible ou deux bornes identiques (`from` égal à `until`, qui pourrait vouloir
dire « toute la journée » comme « jamais ») produisent un avertissement au
démarrage et laissent les mises à jour tourner. Se tromper dans ce sens coûte
quelques requêtes ; se tromper dans l'autre laisse un miroir figé sans que rien
ne l'explique.

---

## Ne pas se faire suspendre par PRONOTE

PRONOTE suspend l'adresse IP au-delà d'un certain rythme d'authentifications, et
répond alors « *Your IP address is suspended.* » à **tout le foyer**. La sanction
a été subie en production sur le plugin ProJote, du même auteur.

Chaque connexion compte : le jeton est renouvelé à chaque fois, ce n'est pas une
session réutilisée.

### Ce qui s'emballe n'est pas le minuteur

`updateInterval` est la partie visible, et la moins dangereuse. Les rafales
viennent d'ailleurs :

| Chemin | Ce qu'il produisait |
|---|---|
| **Rechargement de la page du miroir** | MagicMirror émet `ALL_MODULES_STARTED` à chaque connexion d'un client ; le module renvoyait `SET_CONFIG` et déclenchait une collecte immédiate. **20 rafraîchissements = 20 authentifications.** |
| **Redémarrage en boucle** | Une erreur de syntaxe dans `config.js` fait redémarrer MagicMirror toutes les 60 s ; chaque démarrage déclenchait sa collecte. |
| **`updateInterval` très court** | Saisi par erreur, ou hérité d'un exemple. |
| **Échec persistant** | Réessayer au même rythme un serveur qui refuse prolonge le refus. |

### Les garde-fous

Ils s'appliquent à **toutes** les collectes — minuteur, démarrage,
reconfiguration — mais pas à la même échelle, et la distinction compte.

| Garde-fou | Défaut | Portée | Rôle |
|---|---|---|---|
| Plancher entre deux tentatives | 5 min | **par enfant** | écrase les rafales d'une même collecte |
| Recul après échec | 5 → 10 → 20 min… plafonné à 6 h | par compte | n'insiste pas face à un refus |
| Gel sur suspension annoncée | 6 h | par compte | la seule erreur que réessayer aggrave |
| Plafond quotidien | 60 | par compte | filet de dernier recours |

**Le plancher est par enfant, pas par compte.** Deux instances d'un même compte
parent démarrent à quelques millisecondes d'écart : un plancher par compte
laissait passer la première et bloquait la seconde — et la course se rejouant à
l'identique à chaque cycle, le second enfant ne se mettait *jamais* à jour. Les
trois autres règles restent par compte : c'est le compte que PRONOTE voit, et
une sanction le concerne tout entier.

Conséquence assumée : un rechargement de page coûte une authentification par
enfant affiché. C'est borné par le nombre d'instances — deux ou trois — là où le
défaut d'origine n'était borné par rien.

**Un scan de QR Code remet le recul à zéro.** On rescanne précisément parce que
les collectes échouaient : sans cela, la collecte suivant le scan serait bloquée
jusqu'à six heures, et l'écran resterait inchangé après une action que vous
venez de faire. Le gel sur suspension d'IP, lui, n'est pas levé — un nouveau
jeton ne change rien à une sanction qui porte sur l'adresse.

**L'état est persisté** dans `cache/rate-<compte>.json`. Ce n'est pas un détail :
un compteur en mémoire serait remis à zéro à chaque redémarrage, c'est-à-dire
précisément dans le scénario le plus dangereux.

Un blocage n'est **pas** affiché comme une erreur : les données en place restent
valables, l'écran ne change pas, et la raison est tracée dans les logs.

### Régler les bornes

```js
config: {
  rateLimit: {
    minIntervalMs:        5 * 60000,
    backoffBaseMs:        5 * 60000,
    backoffMaxMs:         6 * 3600000,
    suspensionCooldownMs: 6 * 3600000,
    dailyMaxAttempts:     60
  }
}
```

`null` garde les défauts, et un réglage partiel ne remplace que les clés
fournies. Les abaisser vous expose ; les relever est sans risque.

### Si la suspension est déjà là

Le module l'annonce dans les logs et gèle les collectes six heures :

```
Compte « default » — PRONOTE signale une suspension d'adresse IP.
Collectes gelées jusqu'à … Ne relancez pas le module dans l'intervalle :
chaque tentative prolonge la sanction.
```

Ne redémarrez pas MagicMirror pour « voir si ça remarche » — c'est ce qui
entretient la sanction. Attendez, ou supprimez `cache/rate-<compte>.json` en
sachant exactement ce que vous faites.

---

## Sécurité — clé d'API

Le module expose cinq routes HTTP sur le serveur web de MagicMirror :

| Route | Ce qu'elle donne |
|-------|------------------|
| `/MMM-Pronotepy/config` | la page de configuration, d'où l'on scanne un QR Code |
| `/MMM-Pronotepy/docs` | cette documentation |
| `/MMM-Pronotepy/api/status` | l'identifiant Pronote, l'établissement, les prénoms des enfants |
| `/MMM-Pronotepy/api/logs` | les logs du module |
| `/MMM-Pronotepy/api/clear` | **la suppression des jetons** |

Elles sont toutes protégées par un **middleware d'authentification monté avant
les routes** : rien ne passe sans être autorisé, y compris une route qu'on
ajouterait plus tard.

> Ce point corrige le finding **F-005** de `MMM/modules/SECURITY-AUDIT.md`
> (2026-05-15), relevé sur MMM-Pawmote. Avec `address: "0.0.0.0"` et un
> `ipWhitelist: []` dans `config/config.js` — la configuration courante d'un
> miroir consulté depuis un téléphone — ces routes étaient auparavant ouvertes
> à tout le réseau local.

### Trois modes

**Par défaut — accès local uniquement.**
Les routes ne répondent qu'à `127.0.0.1`. Depuis une autre machine du réseau,
elles renvoient `401`. Un avertissement le rappelle au démarrage dans les logs
de MagicMirror. C'est sûr, mais la page de configuration devient inaccessible
depuis un téléphone — or c'est justement son usage. D'où les deux modes
suivants, qui lèvent la restriction chacun à sa manière.

**Ouverture sans clé — `allowUnauthenticated: true`.**
Les routes répondent à toute machine du réseau, sans rien à saisir. C'est le
plus simple, et c'est un choix défendable sur un réseau domestique maîtrisé.
Ce réglage est volontairement distinct de « pas de clé » : l'absence de clé est
le plus souvent un oubli, alors qu'écrire cette ligne est une décision. Le
démarrage la rappelle par un avertissement explicite.

```js
config: {
  allowUnauthenticated: true
}
```

```bash
# ou, au niveau du conteneur
MMM_PRONOTEPY_ALLOW_UNAUTHENTICATED=true
```

Ce que vous exposez alors à quiconque atteint le port 8080 : votre identifiant
Pronote, l'établissement, les prénoms de vos enfants, les logs du module, et la
possibilité d'effacer les jetons. Rien qui permette de se connecter à Pronote —
le jeton reste sur le disque — mais assez pour que cela mérite d'être su.

**Avec une clé — accès depuis le réseau, authentifié.**
La clé est exigée partout, y compris en local. Elle doit faire **12 caractères
minimum** ; en dessous, elle est ignorée et le module retombe en accès local
(un secret trop court ouvert sur le réseau vaut moins qu'un repli réellement
fermé). Trois façons de la présenter :

```bash
# 1. Dans l'URL — le seul canal possible au premier chargement de la page.
#    La page la range aussitôt en sessionStorage et l'efface de la barre
#    d'adresse, pour qu'elle ne reste ni dans l'historique ni dans un Referer.
http://192.168.1.100:8080/MMM-Pronotepy/config?key=VOTRE_CLE

# 2. En en-tête — ce que fait la page pour tous ses appels ensuite.
curl -H "X-Api-Key: VOTRE_CLE" http://192.168.1.100:8080/MMM-Pronotepy/api/status

# 3. En Bearer — pour vos propres scripts.
curl -H "Authorization: Bearer VOTRE_CLE" http://192.168.1.100:8080/MMM-Pronotepy/api/status
```

Après dix échecs, l'adresse est bloquée une minute — même avec la bonne clé.

> **En mode « serveur seul » (Docker sans Electron), préférez les variables
> d'environnement.** Les réglages écrits dans `config.js` ne parviennent au
> backend que lorsqu'un client charge la page du miroir : c'est le module
> frontend qui les transmet. Tant que personne n'a ouvert
> `http://<miroir>:8080/` dans un navigateur, le backend n'a reçu aucune
> configuration et applique le repli local — vous obtiendrez donc un `401`
> alors que `allowUnauthenticated: true` est bien écrit. Les variables
> `MMM_PRONOTEPY_ALLOW_UNAUTHENTICATED` et `MMM_PRONOTEPY_API_KEY`, elles,
> sont lues dès le démarrage et à chaque requête, sans dépendre d'un client.

Si `apiKey` et `allowUnauthenticated` sont posés tous les deux, **la clé
l'emporte** : entre deux réglages contradictoires, on retient le plus fermé.
Le démarrage signale alors que l'ouverture est ignorée — sans quoi on croirait
l'accès libre et on chercherait longtemps l'origine des 401.

### Où mettre la clé

Générez-en une :

```bash
openssl rand -hex 24
```

Puis, **au choix** :

```js
// config/config.js — le plus simple
{
  module: "MMM-Pronotepy",
  position: "top_left",
  config: {
    apiKey: "collez-ici-la-clé-générée",
    // …
  }
}
```

```bash
# Variable d'environnement — prioritaire sur config.js
export MMM_PRONOTEPY_API_KEY="collez-ici-la-clé-générée"
npm start
```

⚠️ **MagicMirror sert `config/config.js` au navigateur.** Une clé écrite là est
donc lisible par quiconque peut charger la page du miroir. Tant que
`ipWhitelist` restreint qui peut la charger, c'est sans conséquence. Si votre
miroir est ouvert (`ipWhitelist: []`), préférez `MMM_PRONOTEPY_API_KEY` : cette
variable ne quitte jamais le processus Node.

### Vérifier

Depuis une **autre machine** du réseau. En mode clé :

```bash
# Sans clé (ou avec une mauvaise) → 401
curl -i http://192.168.1.100:8080/MMM-Pronotepy/api/status

# Avec la bonne clé → 200
curl -i -H "X-Api-Key: VOTRE_CLE" http://192.168.1.100:8080/MMM-Pronotepy/api/status
```

En mode `allowUnauthenticated`, le premier appel renvoie `200` : c'est le
comportement demandé. Si vous attendiez un `401`, c'est que le réglage est
resté actif — retirez-le.

Dans tous les cas, la ligne de log au démarrage dit sans ambiguïté quel mode
est en vigueur :

```bash
docker logs magic-mirror 2>&1 | grep -E "Routes HTTP|ACCÈS NON AUTHENTIFIÉ|Aucune clé"
```

Et sur le miroir, les jetons doivent n'être lisibles que par leur propriétaire :

```bash
ls -l cache/tokens.json   # attendu : -rw-------
```

---

## Première connexion

MagicMirror² fonctionne sans clavier ni souris. La connexion à votre compte Pronote se fait depuis un autre appareil (téléphone, PC) via la **page web de configuration intégrée**.

### Accéder à la page de configuration

L'adresse dépend du mode d'accès retenu (voir [Sécurité](#sécurité--clé-dapi)) :

```
# avec allowUnauthenticated: true  — rien à saisir
http://<adresse-ip-du-miroir>:8080/MMM-Pronotepy/config

# avec une apiKey
http://<adresse-ip-du-miroir>:8080/MMM-Pronotepy/config?key=<votre-clé>

# par défaut (ni l'un ni l'autre) — depuis le miroir seulement
http://localhost:8080/MMM-Pronotepy/config
```

Remplacez `<adresse-ip-du-miroir>` par l'adresse IP locale de votre miroir (ex. `192.168.1.100`).

---

### Connexion par QR Code

Le QR Code est la **seule** méthode d'authentification, pour un compte **élève** comme **parent**. Votre mot de passe Pronote n'est jamais demandé, ni transmis, ni stocké — seul un jeton de reconnexion finit sur le disque.

> La connexion par identifiants a été retirée volontairement. pronotepy ne délivre de jeton mobile qu'en mode QR Code, et sur les instances PRONOTE 2026 une session applicative ne peut plus émettre de QR Code de remplacement : un compte configuré par mot de passe n'aurait aucun moyen de se reconnecter tout seul.

**Sur votre téléphone (app Pronote officielle) :**

1. Allez dans **Mon profil** (icône en bas à droite)
2. Appuyez sur **Connexion avec QR Code**
3. Choisissez un **PIN** à 4 chiffres et notez-le
4. Un QR Code s'affiche sur l'écran

**Sur la page de configuration :**

5. Choisissez la méthode de saisie :
   - **Coller JSON** : décryptez le QR Code avec une app tierce, copiez le JSON et collez-le
   - **Image** : glissez/déposez ou collez une capture du QR Code
   - **Scanner** : si votre appareil a une caméra, pointez-la vers le QR Code
6. Saisissez votre **PIN**
7. Cliquez sur **✅ Valider**

> ⚠️ Le QR Code Pronote est valable **10 minutes** et à **usage unique**. Si vous l'avez déjà scanné avec l'app Pronote officielle, il est consommé : générez-en un nouveau, dédié au miroir.

Le module distingue les deux causes d'échec les plus fréquentes, qui produisent pourtant la même erreur de déchiffrement AES :

| Message | Cause réelle |
|---|---|
| *Code PIN incorrect* | Le PIN ne correspond pas à celui choisi dans l'application |
| *QR Code expiré ou déjà utilisé* | Le PIN était bon — c'est le jeton du QR que Pronote refuse |
| *Contenu du QR Code illisible* | L'image a été mal décodée (jeton non hexadécimal) |

---

### Compte parent

Si vous avez un compte **parent** avec **plusieurs enfants**, la page de configuration affiche automatiquement les enfants sous forme de cartes après la connexion. Cliquez sur l'enfant souhaité pour voir un exemple de configuration `config.js` prêt à copier-coller.

> Vous n'avez pas besoin de renseigner le nom de l'enfant manuellement : il est détecté automatiquement depuis votre compte Pronote.

---

## Configuration complète

### Référence de toutes les options

```javascript
{
  module: "MMM-Pronotepy",
  position: "top_left",   // top_left | top_center | top_right | ...
  config: {

    // ── Global ─────────────────────────────────────────────────────
    debug:          false,     // true = logs détaillés dans la console
    language:       null,      // null = reprend config.language de MagicMirror (recommandé)
    updateInterval: "60m",     // fréquence de mise à jour : "30s", "5m", "1h", "1d"
    account:        null,      // compte Pronote (jeu de jetons) ; null = "default"
                               // voir « Plusieurs comptes Pronote »
    childName:      null,      // null = premier enfant du token ; "Hugo" = enfant ciblé
    apiKey:         null,      // clé protégeant /config, /docs et /api/* (12 car. min.)
                               // null = accès local uniquement — voir « Sécurité »
    allowUnauthenticated: false, // true = ouvre ces routes à tout le réseau, sans clé
                               // une apiKey renseignée reste prioritaire et exigée
    pythonPath:     null,      // interpréteur exécutant le pont ; null = .venv du module
                               // puis python3 du système — voir « Interpréteur Python »
    offlineMaxAge:  "6h",      // durée pendant laquelle la dernière collecte reste
                               // affichée en cas de coupure — voir « Hors ligne »
    quietHours: { from: "20:00", until: "07:00" },  // pause des mises à jour la nuit
                               // null / false pour désactiver — voir « Fenêtre de nuit »

    // ── En-tête ────────────────────────────────────────────────────
    Header: {
      displayEstablishmentName: true,  // nom de l'établissement (false pour masquer)
      displayStudentName:       true,  // prénom + nom de l'élève
      displayStudentClass:      true,  // classe (ex : 3ème B) (false pour masquer)
    },

    // ── Emploi du temps ────────────────────────────────────────────
    // Si aucun cours aujourd'hui, affiche automatiquement le prochain cours
    // (jour, heure, matière, salle) au lieu de "Plus de cours aujourd'hui".
    Timetable: {
      display:        true,    // activer la section
      displayToday:   true,    // cours du jour restants
      displayNextDay: true,    // emploi du temps du prochain jour scolaire
      displayTeacher: true,    // nom du professeur
      displayRoom:    true,    // salle de cours
      showOnlyFuture: false,   // true = masque les cours déjà terminés aujourd'hui
      showFrom:       "00:00", // n'afficher qu'à partir de cette heure
      showUntil:      "23:59"  // masquer après cette heure
    },

    // ── Devoirs ────────────────────────────────────────────────────
    Homeworks: {
      display:            true,  // activer la section
      displayDone:        true,  // afficher les devoirs déjà cochés (✓)
      displayDescription: true,  // afficher l'énoncé du devoir
      searchDays:         14,    // chercher les devoirs dans les N prochains jours
      showFrom:           "00:00",
      showUntil:          "23:59"
    },

    // ── Notes ──────────────────────────────────────────────────────
    Grades: {
      display:         true,  // activer la section
      displayDuration: 30,    // afficher les notes des N derniers JOURS (0 = toutes)
      number:          10,    // nombre maximum de notes à lister
      showFrom:        "00:00",
      showUntil:       "23:59"
    },

    // ── Absences ───────────────────────────────────────────────────
    Absences: {
      display:         true,
      displayDuration: 60,    // afficher les absences des N derniers JOURS
      number:          5,     // nombre maximum d'absences à lister
      showFrom:        "00:00",
      showUntil:       "23:59"
    },

    // ── Retards ────────────────────────────────────────────────────
    Delays: {
      display:         true,
      displayDuration: 60,    // N derniers JOURS
      number:          5,
      showFrom:        "00:00",
      showUntil:       "23:59"
    },

    // ── Punitions ──────────────────────────────────────────────────
    Punishments: {
      display:         true,
      displayDuration: 60,    // N derniers JOURS
      number:          5,
      showFrom:        "00:00",
      showUntil:       "23:59"
    }
  }
}
```

---

### Plages horaires d'affichage

Chaque section peut être limitée à une ou plusieurs tranches horaires.

#### Tranche unique — `showFrom` / `showUntil`

```javascript
Timetable: {
  display: true,
  showFrom:  "06:30",
  showUntil: "18:00"
}
```

#### Plusieurs tranches — `showRanges`

Utilisez `showRanges` pour définir plusieurs créneaux d'affichage dans la journée. La section est visible dès qu'au moins une tranche est active.

```javascript
Homeworks: {
  display: true,
  showRanges: [
    { from: "06:30", until: "08:30" },
    { from: "16:00", until: "22:00" }
  ]
}
```

> Si `showRanges` est défini, il prend la priorité sur `showFrom`/`showUntil`.  
> Si `display: false`, la section est **toujours masquée**, quelle que soit l'heure.

---

### Exemples de configurations

#### Compte parent — deux enfants

```javascript
// Instance Hugo (top_left)
{
  module: "MMM-Pronotepy",
  position: "top_left",
  config: {
    childName:      "Hugo",
    updateInterval: "60m",
    Header: {
      displayEstablishmentName: false,
      displayStudentName:       true,
      displayStudentClass:      false
    },
    Timetable:   { display: true,  displayToday: true, displayNextDay: true,
                   displayTeacher: true, displayRoom: true },
    Homeworks:   { display: true,  searchDays: 14 },
    Grades:      { display: true,  displayDuration: 30, number: 10 },
    Absences:    { display: true,  displayDuration: 60, number: 5 },
    Delays:      { display: true,  displayDuration: 60, number: 5 },
    Punishments: { display: true,  displayDuration: 60, number: 5 }
  }
},
// Instance Alice (top_center)
{
  module: "MMM-Pronotepy",
  position: "top_center",
  config: {
    childName:      "Alice",
    updateInterval: "60m",
    Header: {
      displayEstablishmentName: false,
      displayStudentName:       true,
      displayStudentClass:      false
    },
    Timetable:   { display: true,  displayToday: true, displayNextDay: true,
                   displayTeacher: true, displayRoom: true },
    Homeworks:   { display: true,  searchDays: 14 },
    Grades:      { display: true,  displayDuration: 30, number: 10 },
    Absences:    { display: true,  displayDuration: 60, number: 5 },
    Delays:      { display: true,  displayDuration: 60, number: 5 },
    Punishments: { display: true,  displayDuration: 60, number: 5 }
  }
}
```

#### Avec plages horaires multiples

```javascript
{
  module: "MMM-Pronotepy",
  position: "top_left",
  config: {
    childName: "Hugo",
    Timetable: {
      display: true,
      showOnlyFuture: true,
      showRanges: [
        { from: "06:30", until: "09:00" },
        { from: "11:00", until: "18:00" }
      ]
    },
    Homeworks: {
      display: true,
      searchDays: 14,
      showRanges: [
        { from: "06:30", until: "08:30" },
        { from: "16:00", until: "22:00" }
      ]
    },
    Grades:      { display: true, displayDuration: 30, number: 5 },
    Absences:    { display: true, displayDuration: 30, number: 3 },
    Delays:      { display: true, displayDuration: 30, number: 3 },
    Punishments: { display: false }
  }
}
```

#### Debug

```javascript
{
  module: "MMM-Pronotepy",
  position: "top_left",
  config: {
    debug: true,
    updateInterval: "2m"
  }
}
```

---

## Système de tokens

Pronote renouvelle le jeton de reconnexion à **chaque authentification** et n'accepte que le **dernier émis**. Un jeton mis de côté « en réserve » est donc déjà mort : conserver un historique ne sert à rien.

Deux mécanismes en découlent, tous deux repris du plugin ProJote où ils ont été mesurés sur une instance PRONOTE 2026.2.5 :

**1. Ne jamais perdre le dernier jeton.** pronotepy se ré-authentifie à la moindre requête refusée — un cycle de collecte peut en compter plusieurs dizaines. Le jeton est donc écrit sur disque dès qu'une authentification réussit, sans attendre la fin du cycle : un arrêt du miroir en pleine collecte ne coûte plus le compte.

**2. Un vrai second appareil.** Puisqu'un ancien jeton est inutilisable, le filet de sécurité ne peut être qu'un **appareil distinct**, enregistré une seule fois au moment du scan avec son propre UUID (suffixé `-bk`). Toutes les instances ne le permettent pas ; le cas échéant le module s'en passe et le signale dans les logs.

### Rotation automatique

```
Cycle de mise à jour (par défaut : toutes les 60 min)
        │
        ▼
  token_login(primary) → Pronote retourne un NOUVEAU token
        │
        ▼
  ancien primary → devient backup
  nouveau token  → devient primary (sauvegardé sur disque)
```

Le fichier `cache/tokens.json` appartient au pont Python : lui seul y écrit, en écriture atomique (`.tmp` + `fsync` + `rename`), ce qui le rend insensible à une coupure de courant. Node ne fait que le lire pour la page de statut.

### Fallback sur le backup

Le token backup n'est utilisé **qu'en cas d'expiration réelle** (erreur d'authentification Pronote). Il ne sera jamais consommé pour une erreur réseau passagère — le primary reste intact et sera réessayé au prochain cycle.

```
primary expiré (SessionExpiredError / AuthenticateError)
        │
        ▼
  token_login(backup) → renouvelle les deux tokens
        │
        └── backup expiré → message d'erreur → ré-authentification requise
```

### Multi-instances (plusieurs enfants)

Quand Hugo et Alice tournent simultanément, un **mutex** sérialise les appels au pont Python : le pont est seul propriétaire des jetons et les fait tourner à chaque connexion, donc deux instances en parallèle brûleraient le même jeton primaire. Le second enfant attend la fin de la collecte du premier et repart des jetons déjà renouvelés.

Les tokens sont stockés dans `cache/tokens.json` (exclu du git). Pour les supprimer : page de configuration → **🗑 Supprimer les tokens**.

---

## Page de configuration

Accessible à l'adresse :

```
http://<adresse-ip-du-miroir>:8080/MMM-Pronotepy/config
```

### Fonctionnalités de la page de config

| Indicateur | Signification |
| --- | --- |
| ✅ **Connecté** | Le module communique avec Pronote sans erreur |
| ⏳ **Token présent** | Token sauvegardé, connexion en cours ou pas encore effectuée |
| ⚠️ **Token expiré** | Les deux tokens ont échoué — reconfigurer le module |
| ❌ **Aucun token** | Première utilisation — s'authentifier |

Après une authentification réussie :

- **Compte élève** : un exemple de bloc `config.js` complet est affiché directement.
- **Compte parent** : les enfants apparaissent sous forme de cartes. Cliquez sur un enfant pour afficher le bloc `config.js` correspondant.

La documentation complète est accessible via le lien **📖 Documentation** en haut de la page.

---

## Dépannage

### ❌ "Aucun token configuré"
→ Rendez-vous sur `http://<ip>:8080/MMM-Pronotepy/config` et authentifiez-vous.

### ❌ "Connexion impossible (token expiré)"
→ Les deux tokens ont expiré. La page de configuration affiche le message ⚠️ Token expiré avec le détail de l'erreur. Reconfigurez le module.

### ❌ L'emploi du temps ne s'affiche pas
→ Vérifiez `Timetable.display: true` et que l'heure est dans la plage `showFrom`/`showUntil`.

### ❌ Les notes ou absences ne s'affichent pas
→ Chaque bloc de collecte (EDT, devoirs, carnet, notes) échoue indépendamment : un onglet désactivé par l'établissement ne vide pas le reste. Activez `debug: true` — les traces du pont Python apparaissent préfixées `py:` dans les logs et sur la page de configuration.

### ❌ Module bloqué sur l'écran de chargement
→ Vérifiez que l'installation Python a réussi : le dossier `.venv/` doit exister. Sinon relancez `npm run setup`.

### ❌ "pronotepy n'est pas installé"
→ L'environnement virtuel est absent ou incomplet. Lancez `npm run setup`. Si la création du venv échoue : `sudo apt install python3-venv`.

### ❌ "Python 3 est introuvable"
→ Aucun interpréteur utilisable. Le module suit l'ordre décrit dans [Interpréteur Python](#interpréteur-python) : `MMM_PRONOTEPY_PYTHON`, puis `pythonPath`, puis `.venv/`, puis le `python3` du système. La ligne de log au démarrage dit lequel a été retenu.

Dans l'ordre :
1. Lancez `npm run setup` dans le dossier du module — cela crée `.venv` et y installe pronotepy.
2. Si le setup échoue sur *« ensurepip is not available »*, il manque `python3-venv` : `sudo apt install python3-venv`.
3. **Sous Docker**, vérifiez d'abord que l'image contient Python — l'image `latest` n'en a pas sur PC. Voir [Sous Docker](#sous-docker--vérifiez-que-limage-contient-python).
4. Si Python vit ailleurs, désignez-le avec `pythonPath` plutôt que de déplacer quoi que ce soit.

### ⚠️ "Aucun venv … repli sur python3" dans les logs
→ Le module n'a pas trouvé son environnement virtuel et utilise le Python du système, qui n'a aucune raison d'avoir pronotepy : la collecte échouera au cycle suivant. C'est un avertissement, pas une erreur — mais il demande une action. Même traitement que le point précédent.

### ❌ 401 « accès refusé » sur la page de configuration
→ Les routes sont fermées au réseau. Trois cas :
- **Ni clé ni ouverture déclarée** (le défaut) : elles ne répondent qu'en local. Le plus simple si vous voulez y accéder depuis un téléphone : `allowUnauthenticated: true`. Le plus sûr : `apiKey`.
- **Clé configurée** : ajoutez `?key=VOTRE_CLE` à l'URL. Un bandeau de saisie apparaît aussi en haut de la page si la clé stockée n'est plus la bonne.
- **`allowUnauthenticated: true` posé, et pourtant 401** : une `apiKey` est également configurée quelque part — elle est prioritaire. Regardez la ligne de démarrage, elle signale l'ouverture ignorée. Pensez aussi à la variable `MMM_PRONOTEPY_API_KEY`, qui l'emporte sur `config.js`.

Après dix échecs, l'adresse est bloquée une minute : attendez avant de réessayer. Le mode retenu est tracé au démarrage dans les logs de MagicMirror.

### ❌ Les données semblent figées le soir ou le week-end
→ PRONOTE 2026 permet aux établissements de **bloquer les mises à jour de l'Espace Élèves le soir, le week-end et pendant les vacances**. Ce n'est pas un défaut du module.

### ❌ "Pas de cours à venir" s'affiche à la place du prochain cours

→ Soit il n'y a effectivement plus de cours planifiés dans Pronote, soit les données n'ont pas encore été récupérées (attendre le prochain cycle de mise à jour).

---

## Structure des fichiers

```text
MMM-Pronotepy/
├── MMM-Pronotepy.js         # Module frontend (navigateur)
├── node_helper.js           # Backend Node.js (routes, cycles, orchestration)
├── pronote_bridge.py        # Pont Python (pronotepy, jetons, collecte)
├── pronote_compat.py        # Correctifs de compatibilité PRONOTE 2026
├── requirements.txt         # Dépendances Python
├── postinstall.js           # Création du venv + install pronotepy
├── pronotepy.css            # Feuille de style
├── LICENSE                  # MIT + attribution des parties héritées
├── package.json
├── lib/                     # Logique pure, testable hors MagicMirror
│   ├── api-auth.js          # Authentification des routes HTTP (copie partagée)
│   ├── bridge-runner.js     # Lancement et surveillance du pont Python
│   ├── bridge-protocol.js   # Décodage de la réponse du pont
│   ├── format.js            # Mise en forme localisée
│   ├── python.js            # Choix de l'interpréteur Python
│   ├── offline-cache.js     # Dernière collecte, pour survivre aux coupures
│   ├── quiet-hours.js       # Fenêtre de nuit
│   ├── accounts.js          # Plusieurs comptes Pronote
│   └── rate-limit.js        # Garde-fous anti-suspension d'IP
├── tests/                   # Suites Node et Python (aucun réseau)
│   ├── conftest.py          # Faux pronotepy + doubles du domaine
│   ├── test_bridge.py
│   ├── test_compat.py
│   ├── api-auth.test.js
│   ├── bridge-runner.test.js
│   ├── bridge-protocol.test.js
│   ├── format.test.js
│   ├── python.test.js
│   ├── offline-cache.test.js
│   ├── quiet-hours.test.js
│   ├── accounts.test.js
│   ├── rate-limit.test.js
│   ├── test_accounts.py
│   └── helpers/             # Faux ponts Python (timeout, crash, flood…)
├── config-page/
│   ├── index.html           # Page web de configuration
│   └── docs.html            # Documentation en ligne
├── templates/
│   ├── layout.njk
│   ├── loading.njk
│   ├── error.njk
│   └── includes/
│       ├── timetable.njk
│       ├── homeworks.njk
│       ├── grades.njk
│       ├── absences.njk
│       ├── delays.njk
│       └── punishments.njk
├── resources/
│   ├── pronote.png
│   └── icon.png
└── cache/                   # Généré automatiquement (gitignore)
    ├── tokens-<compte>.json # Un fichier de jetons par compte Pronote
    ├── last-<compte>-<enfant>.json  # Cache hors ligne
    └── device_uuid.txt
```

---

## Tests

Deux suites, sans réseau ni compte Pronote : les fonctions pures des deux côtés
du pont, et les chemins d'erreur qu'on ne peut pas provoquer à la demande en
production.

```bash
npm test        # Node — auth, pont, formatage, interpréteur, cache hors ligne
npm run test:py # Python — sérialisation, dates, jetons, erreurs, compatibilité
```

Les tests Python n'installent **pas** pronotepy : `tests/conftest.py` en fournit
un double, ce qui garantit qu'aucun test ne sort sur le réseau. Ses dépendances
sont dans `tests/requirements.txt`.

```bash
pip install -r tests/requirements.txt
```

Ce que les suites couvrent en particulier :

| Sujet | Où |
|-------|-----|
| Refus `401` depuis le LAN, sur une vraie socket | `tests/api-auth.test.js` |
| Aucun processus Python survivant après 20 cycles en timeout | `tests/bridge-runner.test.js` |
| Python absent → message actionnable, pas de pile d'appels | `tests/bridge-runner.test.js` |
| `-rw-------` sur `cache/tokens.json` | `tests/test_bridge.py` |
| Chaque couche de compatibilité, sur échantillon figé | `tests/test_compat.py` |
| Le cache hors ligne ne franchit jamais minuit | `tests/offline-cache.test.js` |
| La fenêtre de nuit franchit minuit correctement | `tests/quiet-hours.test.js` |
| Node et le pont Python nomment les comptes pareil | `tests/test_accounts.py` |
| Supprimer un compte ne touche pas les autres | `tests/accounts.test.js` |
| 20 rechargements de page = 1 seule authentification | `tests/rate-limit.test.js` |
| Une suspension gèle les collectes, un succès la lève | `tests/rate-limit.test.js` |

---

## Licence

Le module est publié sous licence **MIT** — même licence que MagicMirror², que
pronotepy, et que les projets dont il descend. Le texte complet est dans
[LICENSE](LICENSE).

### Attribution

MMM-Pronotepy est un travail dérivé. Ni MMM-Pronote ni MMM-Pawmote ne livrent
de fichier `LICENSE` : tous deux se déclarent MIT dans leur `package.json`. La
notice de copyright a donc été reconstituée à partir des auteurs qu'ils
déclarent, pour satisfaire la clause d'attribution de MIT.

| Partie | Origine |
|---|---|
| `pronotepy.css` | ~95 % repris de [MMM-Pawmote](https://github.com/Aldarande/MMM-Pawmote), lui-même dérivé de [MMM-Pronote](https://github.com/bugsounet/MMM-Pronote) |
| `templates/` | gabarits Nunjucks repris de MMM-Pawmote, plusieurs à l'identique |
| `resources/` | ressources graphiques de la même lignée |
| `MMM-Pronotepy.js`, `node_helper.js`, `lib/`, `tests/`, `pronote_bridge.py` | écrits pour ce module |

Auteurs d'origine : Julien « delphiki » Villetorte et bugsounet.

### `pronote_compat.py`

Ce fichier est partagé avec le plugin Jeedom
[ProJote](https://github.com/Aldarande/ProJote) — même auteur. ProJote est sous
AGPL-3.0 ; **cette copie-ci est sous MIT**. Rien ne s'y oppose, l'auteur pouvant
licencier son propre travail deux fois, mais les deux copies ne sont plus
interchangeables : du code repris ici ne peut pas repartir vers ProJote sous MIT.

Il porte deux correctifs indispensables :

- **Challenge d'authentification non chiffré** — depuis le 2 septembre 2026, les instances PRONOTE ≥ 2026.2.5 ne chiffrent plus le challenge renvoyé à l'identification. Sans ce correctif, **tous** les modes de connexion de pronotepy échouent sur `CryptoError` (voir pronotepy [#346](https://github.com/bain3/pronotepy/issues/346) et [#348](https://github.com/bain3/pronotepy/issues/348)). À retirer le jour où pronotepy publie le sien.
- **Onglets non accessibles** — pronotepy traite « onglet non autorisé » comme n'importe quelle erreur et se ré-authentifie avant de rejouer la requête, qui échouera forcément. Chaque authentification fait tourner le jeton, et leur accumulation a déjà valu une suspension d'adresse IP par Pronote.

Les conditions de retrait de chacun sont détaillées en tête de
[`pronote_compat.py`](pronote_compat.py).

---

## Crédits

- **Aldarande** — Développement MMM-Pronotepy
- **Julien "delphiki" Villetorte** — Module MMM-Pronote original
- **bugsounet** — Module MMM-Pronote original
- **[bain3/pronotepy](https://github.com/bain3/pronotepy)** — Bibliothèque de communication Pronote (MIT)
- **[Aldarande/ProJote](https://github.com/Aldarande/ProJote)** — Plugin Jeedom dont viennent les correctifs de compatibilité PRONOTE 2026, la stratégie de jetons et la taxonomie d'erreurs du QR Code

> Ce module dérive de **MMM-Pawmote**, qui reposait sur [Pawnote](https://code.vexcited.com/archive/pawnote1.6.2). Pawnote a été archivé en août 2026 et n'a plus de mainteneur ; pronotepy, bien qu'en mode maintenance, continue de suivre les évolutions de PRONOTE — sa version 2.15.7 vise PRONOTE 2026.2.5.7.

Licence : **MIT**
