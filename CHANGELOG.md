# Changelog

Toutes les évolutions notables de MMM-Pronotepy.

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/).
Ce fichier est détecté par MMM-Remote-Control, qui l'expose dans son interface.

## [Non publié]

### Ajouté

- **Plusieurs comptes Pronote.** Un compte parent ne couvre pas toujours toute
  la fratrie : un enfant peut dépendre d'un autre établissement, ou avoir son
  propre compte élève. L'option `account` désigne un jeu de jetons
  (`cache/tokens-<compte>.json`) ; elle se combine avec `childName`, qui choisit
  un enfant *dans* un compte parent. La page de configuration porte un
  sélecteur de compte. Migration automatique de l'ancien `cache/tokens.json`
  vers le compte `default`, sans rescan.
- **Fenêtre de nuit** (`quietHours`, 20:00 → 07:00 par défaut). Suspend les
  mises à jour périodiques : 44 collectes en moins par jour, donc autant
  d'authentifications PRONOTE et d'écritures sur la carte SD. La collecte au
  démarrage a lieu quoi qu'il arrive, pour qu'un miroir redémarré la nuit ne
  reste pas vide jusqu'au matin.
- **Repli hors ligne** (`offlineMaxAge`, 6 h par défaut). En cas de coupure, la
  dernière collecte est réaffichée avec un bandeau indiquant son heure, au lieu
  de vider l'écran. Le cache ne franchit jamais minuit : `timetableToday`
  signifie « les cours d'aujourd'hui », et rejouer la veille afficherait le
  mauvais emploi du temps.
- **Authentification des routes HTTP.** `/config`, `/docs` et `/api/*` sont
  protégées par un middleware monté avant les routes : clé d'API
  (`apiKey` / `MMM_PRONOTEPY_API_KEY`), ouverture explicite
  (`allowUnauthenticated`), ou accès local uniquement par défaut. Correctif du
  finding F-005 de `MMM/modules/SECURITY-AUDIT.md`.
- **Option `pythonPath`** et variable `MMM_PRONOTEPY_PYTHON`, pour désigner un
  interpréteur ailleurs que dans le venv du module.
- **Suites de tests** : 149 tests Node (`npm test`) et 135 tests Python
  (`npm run test:py`), sans réseau ni compte Pronote.

### Corrigé

- **Le nom affiché était celui du titulaire du compte**, pas celui de l'enfant.
  `client.info` est figé par pronotepy dans `_login` à partir de la ressource du
  compte — sur un compte parent, le parent — et `set_child()` ne la retouche
  jamais. Les données étaient bonnes, l'identité ne l'était pas ; la classe et
  l'établissement manquaient aussi.
- **Le compte mourait au cycle suivant une promotion de l'appareil de secours.**
  Le repli écrivait `tokens["backup"] = None`, et le crochet de persistance
  faisait `store.get("backup", {})` — qui rend la valeur, donc `None`, et non le
  défaut. L'`AttributeError` était avalée et tracée en debug seulement : plus
  aucun jeton n'était persisté, alors que PRONOTE ne retient que le dernier
  émis.
- **`KeyError: 'dataSec'` au lieu de « jeton expiré ».** Sur un compte parent,
  pronotepy ne lève pas d'exception dédiée quand le jeton est refusé :
  `ParentClient.__init__` indexe un dictionnaire vide avant que `require_login()`
  ait pu s'exécuter. L'erreur est désormais classée `auth_failed`.
- **Un interpréteur Python absent pouvait faire tomber MagicMirror.** Écrire sur
  le stdin d'un enfant qui n'a pas démarré émet un `error` sur le flux ; sans
  écouteur, Node le relance en exception.

### Modifié

- Le pont Python est borné : timeout avec escalade SIGTERM puis SIGKILL, limite
  sur stdout, et `ENOENT` distingué pour donner une consigne actionnable plutôt
  qu'une pile d'appels.
- Le cache hors ligne et le fichier de jetons ne sont plus réécrits à
  l'identique — les nuits, week-ends et vacances produisent la même charge
  utile, et réécrire use la carte SD sans contrepartie.
- La logique pure vit dans `lib/`, testable hors du runtime MagicMirror.

## [1.0.0] — 2026-09-03

- Première version : portage de MMM-Pawmote sur `pronotepy`, avec un pont
  Python à la place de Pawnote.
