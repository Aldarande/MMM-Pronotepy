/* Faux pont : exception Python, rien sur stdout, code de sortie non nul. */
'use strict';
process.stderr.write('Traceback (most recent call last):\n');
process.stderr.write('PronoteAPIError: le serveur a ferme la session\n');
process.exit(3);
