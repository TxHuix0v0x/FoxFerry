'use strict';
const { execFile } = require('node:child_process');
const { promisify, isDeepStrictEqual } = require('node:util');
const exec = promisify(execFile);
async function registry(name, previous) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw Error('无效的启动项名称');
  const parser = `Add-Type 'using System;using System.Runtime.InteropServices;public class WinArgs{[DllImport("shell32.dll",CharSet=CharSet.Unicode)]static extern IntPtr CommandLineToArgvW(string s,out int n);[DllImport("kernel32.dll")]static extern IntPtr LocalFree(IntPtr p);public static string[] Split(string s){int n;var p=CommandLineToArgvW(s,out n);if(p==IntPtr.Zero)throw new Exception("Command line parse failed");try{var a=new string[n];for(int i=0;i<n;i++)a[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(p,i*IntPtr.Size));return a;}finally{LocalFree(p);}}}';`;
  const data = previous === undefined ? null : Buffer.from(JSON.stringify(previous)).toString('base64');
  const script = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8;$name='${name}';$paths=@('Software\\Microsoft\\Windows\\CurrentVersion\\Run','Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run');` + (data === null ? `${parser}$values=@();foreach($path in $paths){$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path);try{$values+=,@{value=$(if($key){$key.GetValue($name,$null)}else{$null})}}finally{if($key){$key.Dispose()}}};$values[0].args=@();if($null -ne $values[0].value){$values[0].args=@([WinArgs]::Split($values[0].value))};ConvertTo-Json -InputObject $values -Compress` : `$values=ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')));for($i=0;$i -lt 2;$i++){$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($paths[$i]);try{if($null -eq $values[$i].value){$key.DeleteValue($name,$false)}elseif($i -eq 0){$key.SetValue($name,[string]$values[$i].value,[Microsoft.Win32.RegistryValueKind]::String)}else{$key.SetValue($name,[byte[]]$values[$i].value,[Microsoft.Win32.RegistryValueKind]::Binary)}}finally{$key.Dispose()}}`);
  const { stdout } = await exec('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:10000,encoding:'utf8'});
  return data === null ? JSON.parse(stdout.replace(/^\uFEFF/,'').trim()) : undefined;
}
function matching(item, options) { return item.name === options.name && item.scope === 'user' && item.path.toLowerCase() === options.path.toLowerCase(); }
async function configureLogin(app, options, enabled, allowEnable = true) {
  const previous = await registry(options.name);
  const undo = async () => { if(isDeepStrictEqual(await registry(options.name),previous))return; await registry(options.name,previous); if(!isDeepStrictEqual(await registry(options.name),previous)) throw Error('启动登记回退未通过核验'); };
  try {
    if(enabled && !allowEnable && previous[1].value?.[0] === 3) throw Error('Windows 已禁用此启动项，请在系统启动应用设置中允许 FoxFerry');
    app.setLoginItemSettings({...options,openAtLogin:enabled,enabled});
    const actual = app.getLoginItemSettings(options); const own = actual.launchItems.filter(item => matching(item,options));
    const written = await registry(options.name);
    const exact = written[0].args?.length && written[0].args[0].toLowerCase() === options.path.toLowerCase() && JSON.stringify(written[0].args.slice(1)) === JSON.stringify(options.args);
    if(enabled && (!own.length || !exact)) throw Error('Windows 未能写入匹配的登录启动项，请检查当前用户的登记权限');
    if(enabled && !own.some(item=>item.enabled)) throw Error('Windows 已禁用此启动项，请在系统启动应用设置中允许 FoxFerry');
    if(!enabled && written[0].value !== null) throw Error('Windows 未能撤销 FoxFerry 登录启动项');
    return undo;
  } catch(error) { try { await undo(); } catch(rollback) { throw Error(`${error.message}；${rollback.message}`); } throw error; }
}
module.exports={configureLogin,registry,matching};
