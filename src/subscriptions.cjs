'use strict';
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { parseNodes, safeText } = require('./model.cjs');
async function fetchYaml(raw) {
  let url;
  try { url = new URL(raw); } catch { throw Error('订阅网址无效'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw Error('远程订阅必须使用 HTTPS；凭据可放在服务商提供的查询参数中');
  const result = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'error', headers: { 'User-Agent': 'FoxFerry/0.1 Mihomo' } });
  if (!result.ok) throw Error(`订阅更新失败 (${result.status})`);
  let bytes = 0; const chunks = [];
  for await (const chunk of result.body) { bytes += chunk.length; if (bytes > 16 * 1024 * 1024) throw Error('订阅超过 16MiB 限制'); chunks.push(chunk); }
  return { text: Buffer.concat(chunks).toString('utf8'), metadata: result.headers.get('subscription-userinfo') };
}
async function refresh(sub) {
  const { text, metadata } = sub.kind === 'url' ? await fetchYaml(sub.url) : { text: await fs.readFile(sub.file, 'utf8'), metadata: sub.metadata };
  const nodes = parseNodes(text, sub.id);
  for (const n of nodes) {
    const old = sub.nodes?.find(o => o.id === n.id && JSON.stringify(o.config) === JSON.stringify(n.config));
    if (old?.detectedCountry) { n.detectedCountry = old.detectedCountry; n.detectedAt = old.detectedAt; }
  }
  return { ...sub, nodes, metadata, updatedAt: Date.now(), error: null };
}
async function addSubscription({ name, url, file }) { return refresh({ id: randomUUID(), name: safeText(name, '订阅名称'), kind: url ? 'url' : 'file', ...(url ? { url } : { file }), nodes: [] }); }
module.exports = { fetchYaml, refresh, addSubscription };
