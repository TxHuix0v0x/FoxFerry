'use strict';
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { stringify, yaml } = require('./model.cjs');
const { atomicWrite } = require('./store.cjs');
const exec = promisify(execFile);
function endpoint(config) {
  if (config['external-controller-pipe']) {
    const pipe = config['external-controller-pipe'];
    if (typeof pipe !== 'string' || !pipe.startsWith('\\\\.\\pipe\\') || /[\r\n\0]/.test(pipe)) throw Error('命名管道路径无效');
    return { socketPath: pipe, secret: config.secret || '' };
  }
  const raw = config['external-controller'];
  if (!raw) throw Error('运行配置未提供命名管道或 HTTP 控制接口');
  const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
  if (['0.0.0.0', '[::]'].includes(url.hostname)) url.hostname = '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('只允许本机控制接口');
  return { origin: url.origin, secret: config.secret || '' };
}
function connectionError(error) {
  const messages = { ENOENT: '未找到 Mihomo 控制管道，请确认 Mihomo 内核正在运行后重新发现', ECONNREFUSED: 'Mihomo 控制接口尚未就绪，请稍后重新发现', EACCES: '无权访问 Mihomo 控制接口，请检查 Clash Verge 与 FoxFerry 的运行用户及权限', EPERM: '无权访问 Mihomo 控制接口，请检查 Clash Verge 与 FoxFerry 的运行用户及权限', EPIPE: 'Mihomo 控制连接已断开，请重新发现', ECONNRESET: 'Mihomo 控制连接已重置，请重新发现', ETIMEDOUT: '连接 Mihomo 控制接口超时，请稍后重试' };
  return Object.assign(Error(messages[error.code] || error.message), { code: error.code });
}
function endpointCandidates(config) {
  const first = endpoint(config), result = [first];
  if (first.socketPath) {
    // Verge 2.5.10 writes the sidecar pipe to YAML; its service uses the same owner key and a different channel prefix.
    const sidecar = first.socketPath.match(/^\\\\\.\\pipe\\verge-mihomo-sidecar-(release|dev)-([a-f0-9]{64})$/i);
    const service = first.socketPath.match(/^\\\\\.\\pipe\\verge-mihomo-(production|development)-([a-f0-9]{64})$/i);
    if (sidecar) result.push({ socketPath: `\\\\.\\pipe\\verge-mihomo-${sidecar[1] === 'release' ? 'production' : 'development'}-${sidecar[2]}`, secret: first.secret });
    if (service) result.push({ socketPath: `\\\\.\\pipe\\verge-mihomo-sidecar-${service[1] === 'production' ? 'release' : 'dev'}-${service[2]}`, secret: first.secret });
    if (config['external-controller']) try { result.push(endpoint({ ...config, 'external-controller-pipe': undefined })); } catch { /* A non-local HTTP fallback does not invalidate a local pipe. */ }
  }
  return result;
}
async function resolveController(config) {
  let last;
  for (const candidate of endpointCandidates(config)) {
    try {
      const version = await new Core(candidate).request('GET', '/version', undefined, 1500);
      if (version?.meta !== true || typeof version.version !== 'string') throw Error('控制接口未返回受支持的 Mihomo 版本，请核对配置目录');
      return candidate;
    } catch (error) {
      last = error;
      if (!['ENOENT', 'ECONNREFUSED', 'EPIPE', 'ECONNRESET', 'ETIMEDOUT'].includes(error.code)) throw error;
    }
  }
  throw Object.assign(Error('无法连接 Mihomo：当前用户的控制接口未就绪，请确认 Mihomo 内核正在运行后重新发现'), { code: last?.code });
}
class Core {
  constructor(options) { this.options = options; }
  request(method, route, body, timeout = 8000) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const opts = this.options;
      const url = opts.socketPath ? null : new URL(route, opts.origin);
      const request = (url?.protocol === 'https:' ? https : http).request({ ...(url ? { hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port, protocol: url.protocol } : { socketPath: opts.socketPath, host: 'localhost' }), path: route, method, headers: { ...(opts.secret ? { Authorization: `Bearer ${opts.secret}` } : {}), ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } }, res => {
        let text = ''; let bytes = 0;
        res.on('data', chunk => { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) { res.destroy(); reject(Error('内核响应过大')); } else text += chunk; });
        res.on('error', reject);
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(Error(`内核 ${method} 请求失败 (${res.statusCode})`));
          try { resolve(text ? JSON.parse(text) : null); } catch { reject(Error('内核响应格式无效')); }
        });
      });
      const timer = setTimeout(() => request.destroy(Object.assign(Error('内核请求超时'), { code: 'ETIMEDOUT' })), timeout);
      request.on('close', () => clearTimeout(timer)); request.on('error', error => reject(connectionError(error)));
      request.end(payload);
    });
  }
  proxies() { return this.request('GET', '/proxies'); }
  connections() { return this.request('GET', '/connections'); }
  rules() { return this.request('GET', '/rules'); }
  select(group, name) { return this.request('PUT', `/proxies/${encodeURIComponent(group)}`, { name }); }
  delay(name, url = 'https://www.gstatic.com/generate_204', timeout = 5000) { return this.request('GET', `/proxies/${encodeURIComponent(name)}/delay?timeout=${timeout}&url=${encodeURIComponent(url)}`); }
  close(id) { if (!id || typeof id !== 'string') throw Error('连接 ID 无效'); return this.request('DELETE', `/connections/${encodeURIComponent(id)}`); }
  apply(config) { return this.request('PUT', '/configs?force=false', { payload: stringify(config) }, 20000); }
}
async function validateConfig(binary, config, dataDir, runtimeDir) {
  if (!binary || !path.isAbsolute(binary)) throw Error('请在首次向导中选择本机 Mihomo 可执行文件');
  const stage = await fs.mkdtemp(path.join(dataDir, 'validate-'));
  try {
    if (runtimeDir) for (const file of ['Country.mmdb', 'GeoIP.dat', 'geosite.dat', 'ASN.mmdb']) {
      try { await fs.copyFile(path.join(runtimeDir, file), path.join(stage, file)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    if (runtimeDir) for (const provider of Object.values(config['rule-providers'] || {})) {
      if (!provider.path || path.isAbsolute(provider.path)) continue;
      const source = path.resolve(runtimeDir, provider.path), destination = path.resolve(stage, provider.path);
      if (!source.startsWith(path.resolve(runtimeDir) + path.sep) || !destination.startsWith(stage + path.sep)) throw Error('规则集路径超出配置目录');
      try { await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(source, destination); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    await atomicWrite(path.join(stage, 'config.yaml'), stringify(config));
    try { await exec(binary, ['-t', '-d', stage, '-f', path.join(stage, 'config.yaml')], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }); }
    catch { throw Error('Mihomo 配置校验未通过；未覆盖有效配置，请检查节点协议与规则兼容性'); }
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}
async function readYaml(file) { return yaml(await fs.readFile(file, 'utf8')); }
module.exports = { Core, endpoint, endpointCandidates, resolveController, validateConfig, readYaml, exec };
