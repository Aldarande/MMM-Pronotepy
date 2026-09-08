/* Faux pont : refus applicatif, avec un « kind ». */
'use strict';
process.stdout.write(JSON.stringify({ ok: false, kind: 'auth_failed', error: 'Jeton expire' }));
