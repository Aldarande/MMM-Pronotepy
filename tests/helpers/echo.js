/* Faux pont : renvoie la commande reçue. */
'use strict';
let buffer = '';
process.stdin.on('data', c => { buffer += c; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(buffer || '{}'); } catch { /* laissé vide */ }
  process.stderr.write('pont demarre\n');
  process.stdout.write(JSON.stringify({ ok: true, data: { echo: payload } }));
});
