/* Faux pont : ne repond jamais ET ignore SIGTERM.
 * Force l'escalade vers SIGKILL — le cas du processus Python bloque
 * dans un appel reseau qui n'aboutit pas. */
'use strict';
process.on('SIGTERM', () => { /* ignore volontairement */ });
setInterval(() => {}, 1000);
