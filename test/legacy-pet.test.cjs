'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store.cjs');
const { createDemo } = require('../src/simulation.cjs');
test('legacy pet fields are ignored on load and removed on every save without changing other data', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-legacy-pet-'));
  try {
    const { state } = createDemo();
    state.preferences.follow = true; state.preferences.background.preset = 'warm'; state.preferences.tolerance = 80;
    const expected = structuredClone(state);
    state.preferences.pet = { obsolete: true }; state.preferences.position = 'invalid legacy position';
    await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(state));
    const store = new Store(dir);
    assert.deepEqual(await store.load(), expected);
    await store.save({ ...store.state, preferences: { ...store.state.preferences, pet: true, position: { x: 1, y: 2 } } });
    assert.deepEqual(JSON.parse(await fs.readFile(store.file, 'utf8')), expected);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
