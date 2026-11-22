'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/model.cjs');
const { createDemo } = require('../src/simulation.cjs');
test('three subscriptions preserve duplicate names, stable IDs and independent process rules', () => {
  const { state } = createDemo(); const all = M.nodes(state);
  assert.equal(new Set(all.map(n => n.id)).size, 12);
  const first = all[0]; const updated = M.parseNodes(M.stringify({ proxies: [{ ...first.config, server: 'changed.example' }] }), first.subscriptionId);
  assert.equal(updated[0].id, first.id);
  const config = M.compile(state, { 'mixed-port': 9999, rules: ['GEOIP,CN,DIRECT', 'DOMAIN-SUFFIX,cn,DIRECT', 'RULE-SET,China,DIRECT', 'MATCH,DIRECT'], 'rule-providers': { China: { type: 'inline', behavior: 'domain', payload: ['+.cn'] } } });
  assert.ok(config.rules.includes('GEOIP,CN,DIRECT'));
  assert.deepEqual(config['rule-providers'].China.payload, ['+.cn']);
  assert.ok(config.rules.includes('AND,((PROCESS-NAME,chrome.exe),(DOMAIN-SUFFIX,example.com)),AS_daily'));
  assert.ok(config.rules.includes('AND,((PROCESS-NAME,chrome.exe),(DOMAIN-SUFFIX,example.com)),REJECT'));
  assert.equal(config.rules.at(-1), 'MATCH,REJECT');
  assert.equal(config['mixed-port'], undefined);
  assert.equal(config['proxy-groups'].find(g => g.name === 'AS_qb').proxies[0], M.nodeName(state.scenes[2].selected));
});
test('update removal fails closed; candidate and country limits compile to REJECT', () => {
  const { state } = createDemo(); state.subscriptions[0].nodes.shift();
  assert.equal(M.compile(state)['proxy-groups'][1].proxies[0], 'REJECT');
  state.scenes[1].countries = ['HK'];
  assert.equal(M.compile(state)['proxy-groups'][2].proxies[0], 'REJECT');
});
test('rule matching uses AND between app and domain, OR within each list; no suffix confusion', () => {
  const r = { processes: ['chrome.exe', 'msedge.exe'], domains: ['example.com'] };
  assert.ok(M.matchRule(r, 'Chrome.exe', 'a.example.com'));
  assert.ok(!M.matchRule(r, 'IDMan.exe', 'example.com'));
  assert.ok(!M.matchRule(r, 'chrome.exe', 'notexample.com'));
  assert.equal(M.expression(r), 'AND,((OR,((PROCESS-NAME,chrome.exe),(PROCESS-NAME,msedge.exe))),(DOMAIN-SUFFIX,example.com))');
});
test('reject unsupported format, YAML alias expansion, duplicate keys and unsafe rules', () => {
  for (const text of ['c3M6Ly90ZXN0', 'proxies: []', 'proxies: []\nproxies: []', 'proxy-providers: {}']) assert.throws(() => M.parseNodes(text, 'a'));
  const { state } = createDemo(); state.rules[0].processes = ['x),MATCH,DIRECT']; assert.throws(() => M.compile(state));
  const { state: other } = createDemo(); other.rules[0].domains = ['https://example.com']; assert.throws(() => M.compile(other));
  assert.equal(M.countryFromName, undefined);
});
test('direct entries compile before line entries without a reject companion', () => {
  const { state } = createDemo(); const direct = state.rules[0];
  direct.processes = ['qbittorrent.exe']; direct.processPaths = []; direct.domains = ['example.org']; direct.direct = true;
  const config = M.compile(state);
  const rule = 'OR,((PROCESS-NAME,qbittorrent.exe),(DOMAIN-SUFFIX,example.org)),DIRECT';
  assert.ok(config.rules.includes(rule));
  assert.ok(!config.rules.includes(rule.replace(',DIRECT', ',REJECT')));
  const lineRule = config.rules.find(x => /,AS_[a-z]+$/.test(x));
  assert.ok(config.rules.indexOf(rule) < config.rules.indexOf(lineRule));
  assert.equal(config.rules.at(-1), 'MATCH,REJECT');
  const invalid = structuredClone(state); invalid.rules[0].direct = 'yes';
  assert.throws(() => M.validateState(invalid), /直连标记无效/);
  direct.direct = false;
  assert.ok(M.compile(state).rules.includes('AND,((PROCESS-NAME,qbittorrent.exe),(DOMAIN-SUFFIX,example.org)),AS_daily'));
});
