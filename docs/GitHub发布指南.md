# GitHub 公开发布指南

当前目标仓库：https://github.com/TxHuix0v0x/FoxFerry 。地址已确认，但远程仓库与 Release 可访问性尚未验证；不使用个人主页或包含私人联系方式的用户名。不在源码、配置、日志或安装包保存未经确认的个人标识。

## 发布前

1. 先在 GitHub 自行确认公开用户名不会暴露手机号等私人资料，使用已确认账号 TxHuix0v0x 创建空的公开 FoxFerry 仓库。本轮尚未执行这些操作。
2. 将真实仓库 HTTPS 地址写入 package.json 的 repository 字段（支持字符串或 {type:"git",url:真实地址}）。应用从该字段集中取得 owner/repo；不另设占位配置。当前 package.json 已集中配置该地址。
3. 开发前 npm ci，运行 npm run check、npm test、更新界面专项；确认不会访问虚构测试仓库。最终实链检查需使用确认的真实仓库。
4. 版本推进 0.3.6，构建一次安装包，验证 FoxFerry 品牌、全部包内源码和无运行报告/截图/研究材料。构建后清理 .local 与可重建 node_modules。

## 可提交清单

仅提交 src、assets 中狐狸 PNG/ICO、scripts、test、examples（脱敏样例）、licenses、.github、.gitignore、package.json/lock、LICENSE、NOTICE.md、README.md README.en.md、docs/安装与升级.md、docs/GitHub发布指南.md，以及根目录 VBS/诊断 CMD。

不要提交用户 AppData、state.json、transaction.json、内部 backgrounds、真实 YAML/订阅凭据、docs/验证记录.md 等内部验收记录、运行日志、截图报告、.local、node_modules、.research、release、历史计划和内部交接材料。检查 git status --short 与 git diff --cached；不要对未知工作目录直接 git add .。仓库尚无 .git/remote，本轮未创建、连接或推送远程。

## 首次提交与上传

确认仓库真实地址后，由用户在项目目录 git init，设置 main 分支，将上述清单逐项 git add，再 git diff --cached 检查，git commit。然后使用确认的真实地址设置 origin，核对 git remote -v 后自行 git push -u origin main。以上步骤本轮不自动执行。

安装 EXE 约百 MiB，不进入普通 Git 历史；release/ 整体被忽略。到仓库 Releases → Draft a new release，选择 v0.3.6 标签及对应源码提交，填写变更说明，作为附件上传安装 EXE。确认不是草稿或预发布，再由用户决定发布稳定版。不要上传整个工作目录、开发缓存或私人数据。

应用手动查询 /repos/{owner}/{repo}/releases/latest，不含 token，不上传订阅，不自动下载或安装；未发布稳定 Release 时会如实提示，不伪装为已是最新。

官方说明：[Release 管理](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)、[Release API](https://docs.github.com/en/rest/releases/releases)。


确认准备公开后，可由用户执行（本轮未执行）：

```powershell
git init -b main
git add src assets scripts test examples licenses .github .gitignore package.json package-lock.json LICENSE NOTICE.md README.md README.en.md docs 启动助手.vbs 启动演示.vbs 诊断启动助手.cmd 诊断启动演示.cmd
git diff --cached --stat
git diff --cached
git commit -m "Release FoxFerry 0.3.6"
git remote add origin https://github.com/TxHuix0v0x/FoxFerry.git
git remote -v
git push -u origin main
```

若仓库由网页初始化了 README，先按实际分支历史处理再推送，不使用 force 覆盖远端。到 Releases 创建 v0.3.6，上传 `release/FoxFerry-0.3.6-x64-setup.exe`；公开稳定发布后才可验收真实更新检查。
