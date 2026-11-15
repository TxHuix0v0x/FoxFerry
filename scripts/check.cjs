'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
function visit(dir) { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) visit(file); else if (/\.(cjs|js)$/.test(file)) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' }); } }
for (const dir of ['src', 'test', 'scripts']) visit(dir);
console.log('JavaScript syntax OK');
