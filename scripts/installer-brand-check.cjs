'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
// NSIS build hook: check the actual compiler definitions, not only package metadata.
module.exports = options => {
  if (!Array.isArray(options)) return false;
  const [defines] = options;
  assert.equal(defines.PRODUCT_NAME, 'FoxFerry');
  assert.equal(defines.SHORTCUT_NAME, 'FoxFerry');
  assert.equal(defines.UNINSTALL_DISPLAY_NAME, `FoxFerry ${require('../package.json').version}`);
  assert.equal(defines.APP_ID, 'local.foxferry');
  assert.equal(defines.APP_GUID, 'bc2f3ea5-a4a6-56c5-b4c3-36b6134afad1');
  assert.equal(defines.APP_FILENAME, 'FoxFerry');
  assert.equal(defines.PRODUCT_FILENAME, 'FoxFerry');
  const common = fs.readFileSync(path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis/common.nsh'), 'utf8');
  assert.ok(common.includes('Name "${PRODUCT_NAME}"'), 'installer caption uses verified product name');
  const custom = fs.readFileSync(path.join(__dirname,'installer.nsh'),'utf8');
  assert.ok(custom.includes('MUI_PAGE_CUSTOMFUNCTION_LEAVE FoxFerryDirectoryName'), 'normalize legacy folder after install-mode selection');
  console.log('NSIS compiler brand and upgrade identity verified:', JSON.stringify({ product: defines.PRODUCT_NAME, shortcut: defines.SHORTCUT_NAME, uninstall: defines.UNINSTALL_DISPLAY_NAME, guid: defines.APP_GUID, executable: defines.PRODUCT_FILENAME, directory: defines.APP_FILENAME }));
  return false;
};
