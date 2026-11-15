'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dataDirectory, ownerOf, hasOwnership } = require('../src/identity.cjs');
test('new data directories use FoxFerry; existing settings remain readable without writes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxferry-identity-'));
  try {
    for (const demo of [false, true]) {
      const current = path.join(dir, demo ? 'FoxFerryDemo' : 'FoxFerry');
      const legacy = path.join(dir, demo ? 'ClashRoutingAssistantDemo' : 'ClashRoutingAssistant');
      assert.equal(dataDirectory(dir, demo), current);
      fs.mkdirSync(legacy); fs.writeFileSync(path.join(legacy, 'state.json'), 'original');
      assert.equal(dataDirectory(dir, demo), legacy);
      assert.equal(fs.existsSync(current), false);
      fs.mkdirSync(current); fs.writeFileSync(path.join(current, 'state.json'), 'current');
      assert.equal(dataDirectory(dir, demo), current);
      assert.equal(fs.readFileSync(path.join(legacy, 'state.json'), 'utf8'), 'original');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('new ownership marker has priority while legacy configurations remain readable', () => {
  assert.equal(ownerOf({ 'x-foxferry': { owner: 'new' } }), 'new');
  assert.equal(ownerOf({ 'x-clash-assistant': { owner: 'old' } }), 'old');
  assert.equal(ownerOf({ 'x-foxferry': { owner: 'new' }, 'x-clash-assistant': { owner: 'old' } }), 'new');
  assert.equal(ownerOf({ 'x-foxferry': {}, 'x-clash-assistant': { owner: 'old' } }), undefined);
  assert.equal(hasOwnership({ 'x-clash-assistant': {} }), true);
});
test('project names are FoxFerry; old product tokens only occur in compatibility readers', () => {
  const root = path.resolve(__dirname, '..');
  for (const dir of ['src', 'scripts']) {
    function visit(folder) {
      for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (/\.(?:cjs|js|nsh|html)$/.test(file) && !['identity.cjs', 'installer.nsh'].includes(entry.name)) {
          assert.ok(!/Clash Routing Assistant|clash-routing-assistant|ClashRoutingAssistant|x-clash-assistant|clash-assistant-/.test(fs.readFileSync(file, 'utf8')), file);
        }
      }
    }
    visit(path.join(root, dir));
  }
  const metadata = require('../package.json');
  assert.equal(metadata.name, 'foxferry');
  assert.equal(metadata.build.appId, 'local.foxferry');
  assert.equal(metadata.build.win.executableName, 'FoxFerry');
  const { createDemo } = require('../src/simulation.cjs');
  const config = require('../src/model.cjs').compile(createDemo().state);
  assert.ok(config['x-foxferry']);
  assert.ok(!config['x-clash-assistant']);
});
