# 第三方署名

本项目代码使用 MIT；第三方代码及素材保留各自许可证。

## Codex Maid Widget

来源：[Feeesack/codex-maid-widget](https://github.com/Feeesack/codex-maid-widget)，核查提交 `c13b0706c36d09cd06dfc7dcb69ab185a52c3eef`。

`src/host.cjs` 的会话启动门控参考并改编自 `src/desktop-watcher.cjs` 中的 `DesktopLaunchGate`，改为跟踪 Clash Verge 进程及两次连续退出观测。MIT，Copyright (c) 2026 Codex Maid Widget contributors。完整许可证：[licenses/codex-maid-widget-MIT.txt](licenses/codex-maid-widget-MIT.txt)。窗口、托盘与宿主联动架构参考此项目，其余业务代码为本项目实现；没有引入其额度、聊天、模型或自动委派功能。

当前图标 `assets/fox-logo.png` 与 `assets/fox-logo.ico` 是使用内置图像生成工具为本项目设计的狐狸 Logo，参考上游头像构图与画风，不复用旧角色像素。旧桌宠、参考图和旧图标已从项目及安装包删除。保留上游素材授权说明与 CC BY 4.0 全文作为图标设计来源的许可记录，不表示旧素材仍随产品分发。

上游原素材署名：**Codex Maid Widget artwork, generated with GPTimage2.5, provided by Codex Maid Widget contributors, CC BY 4.0.** 上游对生成方式的陈述并非本项目对作者权利范围的独立保证。

[上游素材授权说明](licenses/ARTWORK_LICENSE.md) · [CC BY 4.0 全文](licenses/CC-BY-4.0.txt)。许可不授予商标权，也不暗示上游作者或服务商背书。

## 运行与构建依赖

当前安装包只包含正在使用的狐狸 Logo，运行时及适用许可证保留。

- Electron：MIT，发行版内含 Chromium/Node.js 及其第三方许可；打包保留 Electron 的 `LICENSE.electron.txt`、`LICENSES.chromium.html` 等文件。
- yaml：ISC，完整许可随生产依赖保存在打包的 `app.asar/node_modules/yaml/LICENSE`。
- electron-builder：MIT；Playwright：Apache-2.0。仅用于开发与测试。
- Mihomo 和 Clash Verge：独立安装、通过公开接口调用；**安装包不包含其二进制或源码**，不对其许可证重新授权。

兼容性研究使用了 Verge v2.5.10（提交 `c83f7ad529c7c9cb3d2d54a0955ef8c1b22a411b`）及 Mihomo Meta 分支（提交 `0455d0d28c4526937380505153e65a843d8612e8`）。上游研究副本已删除。构建不包含用户订阅及运行数据。
