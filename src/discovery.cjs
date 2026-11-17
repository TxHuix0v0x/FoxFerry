'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { exec, readYaml, resolveController } = require('./core.cjs');
const { ownerOf, hasOwnership } = require('./identity.cjs');
const { hash, parseNodes } = require('./model.cjs');
let processCache, processJob;
function acceptProcesses(value) { processCache = value; }
async function processSnapshot(force = false) {
  if (!force && processCache && Date.now() - processCache.at < 3500) return processCache;
  if (processJob) return processJob;
  processJob = (async () => {
    let rows = [];
    if (process.platform === 'win32') {
      const script = "@(Get-CimInstance Win32_Process -Filter \"Name = 'clash-verge.exe' OR Name = 'verge-mihomo.exe' OR Name = 'verge-mihomo-alpha.exe' OR Name = 'mihomo.exe'\" | Sort-Object ProcessId | Select-Object Name,ProcessId,ExecutablePath,CreationDate) | ConvertTo-Json -Compress";
      let stdout;
      try { ({ stdout } = await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000 })); }
      catch (error) { throw Object.assign(Error(error.killed ? '读取本机进程列表超时，请稍后重试' : '读取本机进程列表失败，请确认 PowerShell 可用后重试'), { code: 'EPROCESS' }); }
      const parsed = JSON.parse(stdout.trim() || '[]'); rows = Array.isArray(parsed) ? parsed : [parsed];
    }
    const hosts = rows.filter(p => p.Name === 'clash-verge.exe').map(p => ({ pid:p.ProcessId, exe:p.ExecutablePath, key:`${p.ProcessId}:${p.CreationDate}` }));
    processCache = { at:Date.now(), hosts, kernel:JSON.stringify(rows.filter(p => p.Name !== 'clash-verge.exe').map(p => [p.ProcessId,p.CreationDate])) };
    return processCache;
  })().finally(() => { processJob = null; });
  return processJob;
}
async function inventory() { return (await processSnapshot()).hosts; }
async function kernelIdentity(force = false) { return (await processSnapshot(force)).kernel; }
async function installationPaths() {
  if (process.platform !== 'win32') return [];
  const script = "@(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object DisplayName -eq 'Clash Verge' | Select-Object -ExpandProperty InstallLocation) | ConvertTo-Json -Compress";
  try {
    const { stdout } = await exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 8000 });
    const result = JSON.parse(stdout.trim() || '[]');
    return (Array.isArray(result) ? result : [result]).filter(x => typeof x === 'string').map(x => x.replace(/^"|"$/g, ''));
  } catch { return []; }
}
async function discover(saved = {}, env = process.env) {
  const processes = await inventory();
  const dirs = [...new Set([saved.vergeDir, env.APPDATA && path.join(env.APPDATA, 'io.github.clash-verge-rev.clash-verge-rev'), ...processes.filter(p => p.exe).map(p => path.join(path.dirname(p.exe), 'data'))].filter(Boolean))];
  let dir = '';
  for (const candidate of dirs) try { await fs.access(path.join(candidate, 'profiles.yaml')); dir = candidate; break; } catch {}
  const installs = saved.corePath ? [] : [...processes.filter(p => p.exe).map(p => path.dirname(p.exe)), ...await installationPaths()];
  let corePath = saved.corePath || '';
  if (!corePath) for (const root of installs) for (const file of ['verge-mihomo.exe', 'resources/verge-mihomo.exe']) try { await fs.access(path.join(root, file)); corePath = path.join(root, file); break; } catch {}
  let config = null, controller = null, controllerError = null;
  if (dir) try { config = await readYaml(path.join(dir, 'clash-verge.yaml')); controller = await resolveController(config); } catch (e) { controllerError = e.code === 'ENOENT' && !config ? '未找到 Verge 运行配置，请先启动 Clash Verge' : e.message; }
  return { dir, corePath, processes, config, controller, controllerError };
}
async function vergeSubscriptions(dir, owner) {
  const profile = await readYaml(path.join(dir, 'profiles.yaml'));
  const imported = []; const errors = [];
  for (const item of profile.items || []) {
    if (!['remote', 'local'].includes(item.type) || typeof item.file !== 'string' || !item.uid) continue;
    const root = path.resolve(dir, 'profiles'); const file = path.resolve(root, item.file);
    if (!file.startsWith(root + path.sep)) { errors.push('已忽略目录外的订阅引用'); continue; }
    try {
      const text = await fs.readFile(file, 'utf8');
      const config = require('./model.cjs').yaml(text);
      if (hasOwnership(config) || config['proxy-groups']?.some(g => g.name === require('./model.cjs').marker(owner))) continue;
      const id = `verge_${hash(item.uid)}`;
      imported.push({ id, name: item.name || 'Verge 订阅', kind: 'verge', file, uid: item.uid, updatedAt: Date.now(), nodes: parseNodes(text, id), metadata: item.extra || null });
    } catch { errors.push(`订阅 ${item.name || item.uid} 无法读取或不是受支持的节点 YAML`); }
  }
  return { imported, errors, current: profile.current, items: profile.items || [] };
}
const yamlCache = new Map();
async function profileYaml(file, cached) {
  if (!cached) { yamlCache.delete(file); return readYaml(file); }
  const stat = await fs.stat(file), stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  const old = yamlCache.get(file);
  if (old?.stamp === stamp) return old.value;
  const value = await readYaml(file);
  if (yamlCache.size >= 4) yamlCache.delete(yamlCache.keys().next().value);
  yamlCache.set(file, { stamp, value }); return value;
}
async function ownedProfile(dir, owner, { cached = false } = {}) {
  const { current, items = [] } = await profileYaml(path.join(dir, 'profiles.yaml'), cached);
  const item = items.find(i => i.uid === current);
  if (!item || item.type !== 'local') return null;
  const file = path.resolve(dir, 'profiles', item.file || '');
  const root = path.resolve(dir, 'profiles') + path.sep;
  if (!file.startsWith(root)) return null;
  const cfg = await profileYaml(file, cached);
  return (ownerOf(cfg) === owner || cfg['proxy-groups']?.some(g => g.name === require('./model.cjs').marker(owner))) ? file : null;
}
async function selectedAssistant(dir, owner, options) { return !!await ownedProfile(dir, owner, typeof options === 'object' ? options : undefined); }
module.exports = { inventory, kernelIdentity, processSnapshot, acceptProcesses, discover, vergeSubscriptions, selectedAssistant, ownedProfile };
