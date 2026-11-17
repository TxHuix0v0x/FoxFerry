'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core.cjs');

test('process snapshot failures surface a readable message instead of the raw PowerShell command', async () => {
  const original = core.exec;
  core.exec = async () => { throw Object.assign(Error('Command failed: powershell.exe -NoLogo -NoProfile -Command @(Get-CimInstance Win32_Process ...)'), { killed: true, code: 'ETIMEDOUT' }); };
  try {
    delete require.cache[require.resolve('../src/discovery.cjs')];
    const discovery = require('../src/discovery.cjs');
    await assert.rejects(() => discovery.processSnapshot(true), error => {
      assert.equal(error.code, 'EPROCESS');
      assert.ok(!/powershell|Get-CimInstance|-NoLogo/i.test(error.message), error.message);
      assert.match(error.message, /进程列表/);
      return true;
    });
  } finally {
    core.exec = original;
    delete require.cache[require.resolve('../src/discovery.cjs')];
  }
});
