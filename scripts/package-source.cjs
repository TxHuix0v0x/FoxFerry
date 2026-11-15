'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { version } = require('../package.json');
(async () => {
  const root = path.resolve(__dirname, '..'); await fs.mkdir(path.join(root, '.local'), { recursive: true }); await fs.mkdir(path.join(root, 'release'), { recursive: true });
  const stage = await fs.mkdtemp(path.join(root, '.local/source-'));
  const allowed = ['src', 'assets', 'licenses', 'examples', 'docs', 'test', 'scripts', '.github', '.gitignore', 'package.json', 'package-lock.json', 'LICENSE', 'NOTICE.md', 'README.md', 'README.en.md', '启动演示.vbs', '启动助手.vbs', '诊断启动演示.cmd', '诊断启动助手.cmd'];
  try {
    for (const file of allowed) {
      if(file==='docs'){await fs.mkdir(path.join(stage,'docs'));for(const name of ['安装与升级.md','使用指南.md','GitHub发布指南.md','images'])await fs.cp(path.join(root,'docs',name),path.join(stage,'docs',name),{recursive:true,errorOnExist:true});}
      else await fs.cp(path.join(root,file),path.join(stage,file),{recursive:true,errorOnExist:true});
    }
    const zip = path.join(root, `release/FoxFerry-${version}-source.zip`);
    const quote = v => `'${v.replaceAll("'", "''")}'`;
    execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -LiteralPath ${allowed.map(f => quote(path.join(stage, f))).join(',')} -DestinationPath ${quote(zip)} -Force`], { windowsHide: true, timeout: 60000, stdio: 'inherit' });
    const checksum = createHash('sha256').update(await fs.readFile(zip)).digest('hex'); await fs.writeFile(zip + '.sha256', `${checksum}  ${path.basename(zip)}\n`);
    console.log(`Source archive (explicit allowlist): ${zip}`);
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
