/* MMM-Pronotepy — module MagicMirror² pour Pronote
 * Copyright (C) 2024-2026 Aldarande
 * Licensed under the MIT License. See LICENSE for details.
 */
/* =====================================================================
   MMM-Pronotepy — Module frontend MagicMirror²
   Backend pronotepy (pont Python)
   ===================================================================== */
'use strict';

Module.register('MMM-Pronotepy', {

  requiresVersion: '2.13.0',

  defaults: {
    debug: false,
    language: null,           // null = utilise config.language de MagicMirror
    /* Un emploi du temps ne change pas toutes les quinze minutes, et
     * chaque collecte fait tourner le jeton Pronote — leur accumulation
     * a déjà valu une suspension d'adresse IP. Accepte « 30s » à « 1d ». */
    updateInterval: '60m',
    /* Compte Pronote utilisé par cette instance. Étiquette libre : elle
     * désigne un jeu de jetons (cache/tokens-<compte>.json), donc un
     * compte Pronote distinct.
     * Un compte parent ne couvre pas toujours toute la fratrie — un
     * enfant peut dépendre d'un autre établissement, ou avoir son propre
     * compte élève. `account` sépare les COMPTES, `childName` choisit un
     * enfant DANS un compte parent ; les deux se combinent.
     * null = compte « default », qui reprend l'ancien cache/tokens.json. */
    account: null,

    childName: null,          // null = enfant par défaut du token (compte parent multi-enfants)

    /* Clé d'API protégeant /MMM-Pronotepy/config, /docs et /api/*.
     * 12 caractères minimum, sinon elle est ignorée. Sans clé, ces
     * routes ne répondent qu'en local (127.0.0.1) — cf. README.
     * Attention : MagicMirror sert config/config.js au navigateur ;
     * une clé écrite ici est lisible par qui peut charger le miroir.
     * Sur un réseau non maîtrisé, préférer la variable d'environnement
     * MMM_PRONOTEPY_API_KEY, qui a priorité et ne quitte pas Node. */
    apiKey: null,

    /* Ouvre /config, /docs et /api/* à tout le réseau, sans clé.
     * Réglage distinct de « pas de clé » à dessein : l'absence de clé
     * est le plus souvent un oubli, et laisse alors l'accès local
     * uniquement ; ici, l'ouverture est une décision écrite. Ces routes
     * exposent l'identifiant Pronote et les prénoms des enfants, et
     * permettent d'effacer les jetons — à réserver à un réseau de
     * confiance. Une apiKey renseignée reste prioritaire et exigée.
     * Équivalent : MMM_PRONOTEPY_ALLOW_UNAUTHENTICATED=true */
    allowUnauthenticated: false,

    /* Interpréteur Python exécutant le pont. null = le venv du module
     * (.venv), créé par « npm run setup », puis repli sur le python3 du
     * système. À renseigner quand Python vit ailleurs : image Docker où
     * on l'a installé à la main, venv partagé, Python compilé.
     * MMM_PRONOTEPY_PYTHON, si définie, a priorité sur ce réglage. */
    pythonPath: null,

    /* Coupure réseau : durée pendant laquelle la dernière collecte reste
     * affichée au lieu de laisser place à l'écran d'erreur. « 0 », null
     * ou false désactivent le repli.
     * Le cache ne franchit JAMAIS minuit, quelle que soit cette valeur :
     * « timetableToday » veut dire « les cours d'aujourd'hui », et
     * rejouer la veille afficherait le mauvais emploi du temps. Passé
     * minuit, on revient donc à l'erreur, qui au moins n'affirme rien de
     * faux. Un bandeau indique toujours l'heure de la collecte. */
    offlineMaxAge: '6h',

    /* Fenêtre de nuit : les mises à jour périodiques sont suspendues.
     * Un emploi du temps ne change pas à 3 h du matin, et chaque cycle
     * évité est une authentification de moins auprès de PRONOTE — leur
     * accumulation a déjà valu une suspension d'adresse IP — ainsi
     * qu'une écriture de moins sur la carte SD.
     * La fenêtre franchit minuit : 20:00 → 07:00 couvre bien la nuit.
     * Sans rapport avec showFrom / showUntil, qui masquent des sections
     * à l'écran : ici, seule la COLLECTE s'arrête ; ce qui est affiché
     * le reste. La collecte au démarrage a lieu quoi qu'il arrive, pour
     * qu'un miroir redémarré la nuit ne soit pas vide jusqu'au matin.
     * null, false ou { enabled: false } désactivent la pause. */
    quietHours: { from: '20:00', until: '07:00' },

    /* Garde-fous contre une suspension d'adresse IP par PRONOTE.
     * Ils s'appliquent à TOUTES les collectes, y compris celles
     * déclenchées par un rechargement de la page du miroir ou par un
     * redémarrage — ce sont elles qui font les rafales, pas le minuteur.
     * L'état est persisté par compte : un compteur en mémoire ne
     * protégerait pas d'un redémarrage en boucle, qui est le scénario le
     * plus dangereux. Ne relevez ces valeurs qu'en connaissance de cause.
     *   minIntervalMs        plancher entre deux tentatives
     *   backoffBaseMs/MaxMs  recul croissant après un échec
     *   suspensionCooldownMs gel si PRONOTE annonce la suspension
     *   dailyMaxAttempts     plafond par compte et par jour */
    rateLimit: null,

    Header: {
      displayEstablishmentName: true,
      displayStudentName: true,
      displayStudentClass: true,
      displayAvatar: false
    },

    Timetable: {
      display: true,
      displayToday: true,
      displayNextDay: true,
      displayTeacher: true,
      displayRoom: true,
      showOnlyFuture: false,  // n'affiche que les cours à venir
      showHolidays: false,    // remplace "Aujourd'hui" par un bloc vacances + countdown

      /* Fenêtre de la section entière. */
      showFrom: '00:00',
      showUntil: '23:59',

      /* Fenêtres propres à chaque sous-bloc, facultatives. Elles
       * RESTREIGNENT la fenêtre de section, elles ne l'élargissent pas.
       * Absentes (null), le sous-bloc suit la section — comportement
       * d'origine.
       * Usage typique : la journée en cours le matin, celle du lendemain
       * le soir, pour ne pas afficher deux emplois du temps à la fois.
       *   today:   { showFrom: '06:00', showUntil: '14:00' },
       *   nextDay: { showFrom: '17:00', showUntil: '23:59' }
       * Acceptent aussi showRanges: [{ from, until }, ...]. */
      today: null,
      nextDay: null
    },

    Homeworks: {
      display: true,
      displayDone: true,       // afficher les devoirs faits (cochés)
      displayDescription: true,
      searchDays: 14,          // chercher les devoirs dans les N prochains jours
      showHolidays: true,      // afficher les devoirs pendant les vacances
      showFrom: '00:00',
      showUntil: '23:59'
    },

    Grades: {
      display: true,
      displayDuration: 30,     // afficher les notes des N derniers jours
      number: 10,              // nombre maximum de notes à afficher
      showHolidays: false,     // masquer les notes pendant les vacances
      showFrom: '00:00',
      showUntil: '23:59'
    },

    Absences: {
      display: true,
      displayDuration: 60,     // afficher les absences des N derniers jours
      number: 5,
      showHolidays: false,     // masquer les absences pendant les vacances
      showFrom: '00:00',
      showUntil: '23:59'
    },

    Delays: {
      display: true,
      displayDuration: 60,
      number: 5,
      showHolidays: false,     // masquer les retards pendant les vacances
      showFrom: '00:00',
      showUntil: '23:59'
    },

    Punishments: {
      display: true,
      displayDuration: 60,
      number: 5,
      showHolidays: false,     // masquer les punitions pendant les vacances
      showFrom: '00:00',
      showUntil: '23:59'
    }
  },

  /* ── Initialisation ─────────────────────────────────────────────── */
  start () {
    this.config   = configMerge({}, this.defaults, this.config);
    if (!this.config.language) this.config.language = config.language || 'fr-FR';
    this.userData = null;
    this.loading  = true;
    this.error    = null;
    this.stale    = null;
    Log.info(`[${this.name}] Module démarré`);
  },

  /* Bandeau « hors ligne » prêt à afficher, ou null. */
  _staleBanner () {
    if (!this.stale) return null;
    const quand = new Date(this.stale.collectedAt);
    const heure = isNaN(quand.getTime())
      ? ''
      : quand.toLocaleTimeString(this.config.language || 'fr-FR',
                                 { hour: '2-digit', minute: '2-digit', hour12: false });
    return { time: heure, ageMinutes: this.stale.ageMinutes, reason: this.stale.reason };
  },

  /* ── Styles ─────────────────────────────────────────────────────── */
  getStyles () {
    return ['pronotepy.css'];
  },

  /* ── Template ───────────────────────────────────────────────────── */
  getTemplate () {
    if (this.loading)                 return 'templates/loading.njk';
    if (this.error || !this.userData) return 'templates/error.njk';
    return 'templates/layout.njk';
  },

  getTemplateData () {
    if (this.loading) {
      return { loading: 'Connexion à Pronote…' };
    }
    if (this.error || !this.userData) {
      const configPath = (this.error && this.error.configUrl) || '/MMM-Pronotepy/config';
      return {
        error:         this.error || { message: 'Aucune donnée', configUrl: configPath },
        configUrl:     configPath,
        fullConfigUrl: window.location.origin + configPath
      };
    }
    const vis = {
      Timetable:   this._isVisible(this.config.Timetable),
      Homeworks:   this._isVisible(this.config.Homeworks),
      Grades:      this._isVisible(this.config.Grades),
      Absences:    this._isVisible(this.config.Absences),
      Delays:      this._isVisible(this.config.Delays),
      Punishments: this._isVisible(this.config.Punishments)
    };

    /* ── Visibilité par sous-section ────────────────────────────────
       vis.Timetable = false  → toute la section est masquée (display:false ou hors plage horaire)
       displayToday / displayNextDay → choix indépendant dans la section visible           */
    const ttVis      = vis.Timetable;
    const hasToday   = (this.userData.timetableToday || []).length > 0;

    /* Aujourd'hui : displayToday, sa propre fenêtre horaire si elle
       existe, ET (cours présents OU showHolidays activé) */
    const showToday   = !!(ttVis && this.config.Timetable.displayToday
                           && this._isSubVisible(this.config.Timetable, 'today')
                           && (hasToday || this.config.Timetable.showHolidays));

    /* Prochain jour : displayNextDay, sa propre fenêtre, et des données */
    const showNextDay = !!(ttVis && this.config.Timetable.displayNextDay
                           && this._isSubVisible(this.config.Timetable, 'nextDay')
                           && this.userData.timetableNextDay);

    const homeworks    = this.userData.homeworks || [];
    const pendingCount = homeworks.filter(h => !h.done).length;
    const showHomeworks = pendingCount > 0;

    /* Grouper les devoirs par échéance et dédupliquer les matières (ex: PHYSIQUE-CHIMIE ×3) */
    const hwRows = [];
    const byDeadline = new Map();
    for (const hw of homeworks) {
      if (hw.done) continue;
      if (!byDeadline.has(hw.deadline)) {
        byDeadline.set(hw.deadline, { deadline: hw.deadline, dueTomorrow: hw.dueTomorrow, subjects: [] });
      }
      byDeadline.get(hw.deadline).subjects.push(hw.subject);
    }
    for (const row of byDeadline.values()) {
      const counts = new Map();
      for (const s of row.subjects) counts.set(s, (counts.get(s) || 0) + 1);
      const seen  = new Set();
      const parts = [];
      for (const s of row.subjects) {
        if (seen.has(s)) continue;
        seen.add(s);
        parts.push(counts.get(s) > 1 ? `${s} ×${counts.get(s)}` : s);
      }
      hwRows.push({ deadline: row.deadline, dueTomorrow: row.dueTomorrow, subjectsText: parts.join(' · ') });
    }

    /* ── Détection du créneau repas : un seul séparateur affiché par jour ──
       Cherche le gap le plus long dans la fenêtre 11:30–14:00 (≥ 30 min).
       Retourne -1 si aucun gap ne qualifie → pas de séparateur "repas". */
    const findLunchBreakIndex = (entries) => {
      if (!Array.isArray(entries) || entries.length < 2) return -1;
      const toMin = (t) => {
        if (typeof t !== 'string') return null;
        const m = t.match(/^(\d{1,2}):(\d{2})$/);
        return m ? parseInt(m[1], 10) * 60 + parseInt(m[2], 10) : null;
      };
      let bestIdx = -1;
      let bestGap = 0;
      for (let i = 1; i < entries.length; i++) {
        const prevEnd  = toMin(entries[i - 1].end);
        const curStart = toMin(entries[i].start);
        if (prevEnd === null || curStart === null) continue;
        if (prevEnd >= 11 * 60 + 30 && curStart <= 14 * 60 && curStart - prevEnd >= 30) {
          const gap = curStart - prevEnd;
          if (gap > bestGap) { bestGap = gap; bestIdx = i; }
        }
      }
      return bestIdx;
    };
    const lunchIdxToday = findLunchBreakIndex(this.userData.timetableToday);
    const lunchIdxNext  = findLunchBreakIndex(this.userData.timetableNextDay && this.userData.timetableNextDay.classes);

    /* ── Heure de fin de journée : end du dernier cours NON annulé ────── */
    const findLastNonCancelledEnd = (entries) => {
      if (!Array.isArray(entries) || entries.length === 0) return '';
      for (let i = entries.length - 1; i >= 0; i--) {
        if (!entries[i].cancelled && entries[i].end) return entries[i].end;
      }
      return '';
    };
    const lastLessonEndToday = findLastNonCancelledEnd(this.userData.timetableToday);
    const lastLessonEndNext  = findLastNonCancelledEnd(this.userData.timetableNextDay && this.userData.timetableNextDay.classes);

    Log.info(`[${this.name}] showToday=${showToday} showNextDay=${showNextDay} grades=${this.userData.grades?.length} absences=${this.userData.absences?.length} lunchIdx=today:${lunchIdxToday}/next:${lunchIdxNext} lastEnd=today:${lastLessonEndToday}/next:${lastLessonEndNext}`);
    const today = new Date();
    const todayLabel = today.toLocaleDateString(this.config.language || 'fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    return {
      config:       this.config,
      userData:     this.userData,
      /* Non nul = les données viennent du cache hors ligne. Le gabarit
       * l'affiche : un écran qui tait sa péremption ment. L'heure est
       * mise en forme ici — le module n'enregistre pas de filtre
       * Nunjucks, et en ajouter un pour une seule date serait cher. */
      stale:        this._staleBanner(),
      vis,
      showToday,
      showNextDay,
      showHomeworks,
      pendingCount,
      hwRows,
      todayLabel,
      lunchIdxToday,
      lunchIdxNext,
      lastLessonEndToday,
      lastLessonEndNext
    };
  },

  /* ── Visibilité horaire ─────────────────────────────────────────── */
  /* Sommes-nous dans la fenêtre horaire décrite par ce bloc ?
   * Ne regarde QUE les horaires — pas le drapeau `display`. Séparer les
   * deux permet d'appliquer la même grammaire (`showFrom`/`showUntil` ou
   * `showRanges`) à une section entière comme à un sous-bloc, qui a son
   * propre drapeau (`displayToday`, `displayNextDay`). */
  _inWindow (cfg, now) {
    if (!cfg) return true;
    const t    = now || new Date();
    const hhmm = t.getHours().toString().padStart(2, '0') + ':' +
                 t.getMinutes().toString().padStart(2, '0');

    /* Plusieurs tranches : showRanges: [{ from, until }, ...] */
    if (Array.isArray(cfg.showRanges) && cfg.showRanges.length > 0) {
      return cfg.showRanges.some(r => hhmm >= (r.from || '00:00') && hhmm <= (r.until || '23:59'));
    }

    /* Tranche unique (rétrocompatibilité) : showFrom / showUntil */
    const from  = cfg.showFrom  || '00:00';
    const until = cfg.showUntil || '23:59';
    return hhmm >= from && hhmm <= until;
  },

  _isVisible (sectionCfg, now) {
    if (!sectionCfg || !sectionCfg.display) return false;
    return this._inWindow(sectionCfg, now);
  },

  /* Fenêtre d'un sous-bloc de l'emploi du temps.
   *
   * `Timetable.today` et `Timetable.nextDay` peuvent porter leurs propres
   * horaires — afficher la journée en cours le matin, celle du lendemain
   * le soir. En leur absence, le sous-bloc hérite de la fenêtre de la
   * section, ce qui préserve le comportement d'avant.
   *
   * Un sous-bloc RESTREINT, il n'élargit pas : la fenêtre de section
   * reste souveraine. Sans cela, un réglage de sous-bloc pourrait
   * rallumer une section que l'on a explicitement éteinte. */
  _isSubVisible (sectionCfg, sousBloc, now) {
    if (!this._isVisible(sectionCfg, now)) return false;
    const cfg = sectionCfg && sectionCfg[sousBloc];
    return cfg ? this._inWindow(cfg, now) : true;
  },

  /* ── Notifications MagicMirror ──────────────────────────────────── */
  notificationReceived (notification) {
    if (notification === 'ALL_MODULES_STARTED') {
      this.sendSocketNotification('SET_CONFIG', { ...this.config, _instanceId: this.identifier });
    }
  },

  /* ── Notifications socket (NodeHelper) ─────────────────────────── */
  socketNotificationReceived (notification, payload) {
    /* Filtre les messages destinés à cette instance */
    if (payload && payload._instanceId && payload._instanceId !== this.identifier) return;

    switch (notification) {

      case 'INITIALIZED':
        Log.info(`[${this.name}] Initialisé`);
        break;

      case 'PRONOTE_UPDATED':
        this.loading  = false;
        this.error    = null;
        this.userData = payload;
        /* Non nul quand les données viennent du cache hors ligne : le
         * gabarit doit le dire, sinon l'écran affirme être à jour. */
        this.stale    = payload.stale || null;
        this.updateDom(500);
        this.sendNotification('PRONOTE_DATA', payload);
        break;

      case 'ERROR':
        this.loading  = false;
        this.error    = payload;
        this.userData = null;
        this.stale    = null;
        this.updateDom();
        break;

      case 'TOKEN_SAVED':
        Log.info(`[${this.name}] Token sauvegardé — ${payload.username || ''}`);
        this.loading  = true;
        this.error    = null;
        this.userData = null;
        this.updateDom();
        break;

      case 'TOKEN_CLEARED':
        this.loading  = false;
        this.userData = null;
        this.error    = {
          type:      'no_tokens',
          message:   'Les tokens ont été supprimés. Reconfigurez le module.',
          configUrl: '/MMM-Pronotepy/config'
        };
        this.updateDom();
        break;

      default:
        Log.warn(`[${this.name}] Notification socket non gérée : ${notification}`);
    }
  }
});
