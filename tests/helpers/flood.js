/* Faux pont : deverse sur stdout sans jamais s'arreter. */
'use strict';
const bloc = 'x'.repeat(64 * 1024);
setInterval(() => process.stdout.write(bloc), 1);
