'use strict';
/* MMM-Pronotepy — module MagicMirror² pour Pronote
 * Copyright (C) 2024-2026 Aldarande
 * Licensed under the MIT License. See LICENSE for details.
 */

/* =====================================================================
   MMM-Pronotepy — lib/format.js
   Mise en forme localisée de la charge utile du pont Python.

   Le pont renvoie des dates ISO et rien d'autre : toute la localisation
   reste ici, côté Node, qui dispose d'Intl et de la langue de
   MagicMirror. Extrait de node_helper.js pour être testable sans le
   runtime MagicMirror (`require('node_helper')` n'existe qu'au sein du
   miroir).
   ===================================================================== */

function formatTime (iso, lang) {
  if (!iso) return '';
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatDate (iso, lang, opts) {
  if (!iso) return '';
  /* Une date nue (YYYY-MM-DD) serait interprétée en UTC et pourrait
   * reculer d'un jour selon le fuseau — on force midi local. */
  const dt = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T12:00:00`) : new Date(iso);
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString(lang, opts || {});
}

function mapEntry (entry, lang) {
  return { ...entry, start: formatTime(entry.start, lang), end: formatTime(entry.end, lang) };
}

/* Transforme la charge utile brute du pont en données prêtes à afficher */
function localize (raw, lang) {
  const source    = raw || {};
  const shortDate = { day: 'numeric', month: 'short', year: 'numeric' };
  const nextDay   = source.timetableNextDay || {};

  return {
    name:          source.name          || '',
    className:     source.className     || '',
    establishment: source.establishment || '',
    childName:     source.childName     || '',
    children:      source.children      || [],

    timetableToday: (source.timetableToday || []).map(e => mapEntry(e, lang)),
    cancelledToday: source.cancelledToday || 0,
    noClassesToday: !!source.noClassesToday,
    todayStart:     formatTime(source.todayStart, lang),
    todayEnd:       formatTime(source.todayEnd,   lang),

    timetableNextDay: {
      day:       formatDate(nextDay.date, lang, { weekday: 'long', day: 'numeric', month: 'long' }),
      start:     formatTime(nextDay.start, lang),
      end:       formatTime(nextDay.end,   lang),
      daysUntil: nextDay.daysUntil ?? null,
      classes:   (nextDay.classes || []).map(e => mapEntry(e, lang))
    },

    homeworks: (source.homeworks || []).map(h => ({
      ...h,
      deadline: formatDate(h.deadline, lang, { weekday: 'short', day: 'numeric', month: 'short' })
    })),

    grades: (source.grades || []).map(g => ({
      ...g,
      date:          (g.date || '').slice(0, 10),
      formattedDate: formatDate(g.date, lang, {})
    })),

    absences:    (source.absences    || []).map(a => ({ ...a, formattedDate: formatDate(a.date, lang, shortDate) })),
    delays:      (source.delays      || []).map(d => ({ ...d, formattedDate: formatDate(d.date, lang, shortDate) })),
    punishments: (source.punishments || []).map(p => ({ ...p, formattedDate: formatDate(p.date, lang, shortDate) }))
  };
}

/* « 15m », « 2h »… → millisecondes. Toute valeur non reconnue retombe
 * sur 15 minutes : un intervalle mal orthographié ne doit pas se
 * transformer en boucle de rafraîchissement à la milliseconde. */
function parseInterval (str) {
  const m = String(str).match(/^(\d+)([smhd])$/);
  if (!m) return 15 * 60 * 1000;
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  const value = parseInt(m[1], 10) * (multipliers[m[2]] || 60000);
  return value > 0 ? value : 15 * 60 * 1000;
}

module.exports = { formatTime, formatDate, mapEntry, localize, parseInterval };
