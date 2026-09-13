# Changelog

Toutes les évolutions notables de MMM-Pronotepy.

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/).
Ce fichier est détecté par MMM-Remote-Control, qui l'expose dans son interface.

## [1.1.1] — 2026-09-13

### Corrigé

- **Le second enfant d'un compte parent ne se mettait jamais à jour.**
  Régression de la 1.1.0 : le plancher de 5 min des garde-fous était indexé par
  compte. Deux instances d'un même compte parent démarrent à quelques
  millisecondes d'écart — la première passait, la seconde était bloquée, et la
  course se rejouait à l'identique au cycle suivant. Mesuré : 0 collecte sur 4
  cycles pour le second enfant. Le plancher est désormais par enfant ; la
  suspension, le recul après échec et le plafond quotidien restent par compte,
  puisque c'est le compte que PRONOTE voit.
- **La collecte suivant un scan de QR Code pouvait être bloquée jusqu'à 6 h.**
  On rescanne parce que les collectes échouaient, donc avec un recul accumulé :
  l'écran restait inchangé après l'action attendue de l'utilisateur. Un scan
  remet à zéro le recul et les planchers du compte — mais pas le gel sur
  suspension d'IP, qu'un nouveau jeton ne lève pas, ni le plafond quotidien.

## [1.1.0] — 2026-09-12

### Ajouté

- **Garde-fous contre une suspension d'adresse IP par PRONOTE.** Le danger ne
  venait pas de `updateInterval` mais des collectes hors minuteur : un
  rechargement de la page du miroir renvoyait `SET_CONFIG` et déclenchait une
  authentification immédiate — vingt rafraîchissements en faisaient vingt —, et
  un redémarrage en boucle rejouait la collecte de démarrage chaque minute.
  Désormais un plancher de 5 min entre tentatives, un recul croissant après
  échec, un gel de 6 h si PRONOTE annonce la suspension, et un plafond
  quotidien par compte. L'état est persisté : un compteur en mémoire ne
  protégerait pas du redémarrage en boucle. Nouveau `kind` d'erreur
  `ip_suspended`, distinct de `network` — c'est la seule erreur que réessayer
  aggrave.

### Modifié

- **`updateInterval` passe de 15 min à 60 min par défaut.** Un emploi du temps
  est publié la veille au soir et ne bouge plus de la journée ; quatre collectes
  par heure n'apportaient rien et faisaient tourner le jeton d'autant. Combiné à
  la fenêtre de nuit : 13 collectes par jour au lieu de 52. Le repli de
  `parseInterval` pour une valeur illisible suit la même valeur, afin qu'un
  réglage mal orthographié n'interroge pas PRONOTE plus souvent que ce que la
  documentation annonce.
- La procédure d'installation remonte juste après les prérequis. Elle existait,
  mais derrière cinq sections de référence : un lecteur qui vient d'arriver ne la
  trouvait pas. Ajout d'un volet Docker, avec la contrainte qui coûte le plus de
  temps quand on l'ignore — le venv doit être créé DANS le conteneur.

## [1.0.0] — 2026-09-08

Première publication. Portage de MMM-Pawmote sur `pronotepy`, avec un pont
Python à la place de Pawnote. Le travail antérieur au 2026-09-08 n'a jamais été
distribué : il est intégralement décrit ici.

### Ajouté

- **Plusieurs comptes Pronote.** Un compte parent ne couvre pas toujours toute
  la fratrie : un enfant peut dépendre d'un autre établissement, ou avoir son
  propre compte élève. L'option `account` désigne un jeu de jetons
  (`cache/tokens-<compte>.json`) ; elle se combine avec `childName`, qui choisit
  un enfant *dans* un compte parent. La page de configuration porte un
  sélecteur de compte. Migration automatique de l'ancien `cache/tokens.json`
  vers le compte `default`, sans rescan.
- **Fenêtre de nuit** (`quietHours`, 20:00 → 07:00 par défaut). Suspend les
  mises à jour périodiques : 11 collectes en moins par jour sur 24, donc autant
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
