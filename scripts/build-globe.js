const { build } = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const packages = ['three', 'd3-geo', 'd3-array', 'internmap', 'topojson-client', 'world-atlas'];
fs.writeFileSync('public/js/globe.LICENSES.txt', packages.map(name => {
    return `${name}\n${'='.repeat(name.length)}\n${fs.readFileSync(path.join('node_modules', name, 'LICENSE'), 'utf8')}`;
}).join('\n\n'));

// The committed browser bundle includes libraries and Natural Earth geography.
// Production uses it directly, with no CDN, external map API, or build tool needed.
build({
    entryPoints: ['client/globe.mjs'],
    outfile: 'public/js/globe.bundle.js',
    bundle: true,
    minify: true,
    target: ['es2022'],
    format: 'iife',
    legalComments: 'linked',
    logLevel: 'info'
}).catch(() => { process.exitCode = 1; });
