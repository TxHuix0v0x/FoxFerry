'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { initialState, upgradeState, validateState, backgroundDefaults } = require('../src/model.cjs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/store.cjs');
const { Service } = require('../src/service.cjs');

test('旧数据补齐背景默认值，且背景校验不影响原有调度参数', () => {
  const old = initialState(); delete old.preferences.background;
  const migrated = upgradeState(old);
  assert.deepEqual(migrated.preferences.background, backgroundDefaults);
  assert.equal(old.preferences.background, undefined);
  assert.equal(migrated.preferences.delayInterval, old.preferences.delayInterval);
  const previous = initialState(); delete previous.preferences.background.panelOpacity; delete previous.preferences.background.panelBlur;
  previous.preferences.background.preset = 'warm';
  const upgraded = upgradeState(previous);
  assert.equal(upgraded.preferences.background.preset, 'warm');
  assert.equal(upgraded.preferences.background.panelOpacity, 100); assert.equal(upgraded.preferences.background.panelBlur, 0);
  const bad = structuredClone(migrated); bad.preferences.background.opacity = 101;
  assert.throws(() => validateState(bad), /背景设置无效/);
  bad.preferences.background.opacity = 25; bad.preferences.background.panelBlur = 51;
  assert.throws(() => validateState(bad), /面板设置无效/);
  bad.preferences.background.opacity = 25; bad.preferences.background.imageId = '../state.json';
  assert.throws(() => validateState(bad), /背景设置无效/);
  const badStyle = structuredClone(migrated); badStyle.preferences.background.lineDepth = 101;
  assert.throws(() => validateState(badStyle), /线条与阴影设置无效/);
  badStyle.preferences.background.lineDepth = 40; badStyle.preferences.background.shadow = -1;
  assert.throws(() => validateState(badStyle), /线条与阴影设置无效/);
});

test('演示模式重建模拟数据时保留背景设置', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxferry-background-'));
  let service;
  try {
    service = await new Service(new Store(dir), { demo:true }).init();
    await service.command('preferences', { background:{ ...backgroundDefaults, preset:'warm' } });
    await service.command('preferences', { tolerance: 80, follow: true });
    await service.close();
    service = await new Service(new Store(dir), { demo:true }).init();
    assert.equal(service.state.preferences.background.preset, 'warm');
    assert.equal(service.state.preferences.tolerance, 80); assert.equal(service.state.preferences.follow, true);
  } finally { if(service) await service.close(); await fs.rm(dir, { recursive:true, force:true }); }
});
