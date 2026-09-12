// Keep the release version stable; build timestamps belong to build-info.json.
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const buildDate = new Date().toISOString();
fs.writeFileSync(path.join(root, 'build-info.json'), JSON.stringify({ version: pkg.version, buildDate }));
console.log('[build-info] version =', pkg.version, '| buildDate =', buildDate);
