# LibreTV 开发任务列表

## 1. 环境准备与 Tauri 项目初始化
- [x] 1.1 安装 Rust 和 Node.js
  - 关键文件: `tauri.conf.json`, `Cargo.toml`, `package.json`
  - 优先级: 高 | 预估: 1-2天
  - 验收标准: 确保 Rust 工具链 (rustup, cargo) 和 Node.js (npm/yarn) 已正确安装并配置好。Tauri CLI 安装成功。

- [x] 1.2 创建 Tauri 项目
  - 关键文件: `tauri.conf.json`, `src-tauri/` 目录结构
  - 优先级: 高 | 预估: 0.5天
  - 验收标准: 项目能够成功创建，并能运行 `cargo tauri dev`。

- [x] 1.3 配置 `tauri.conf.json`
  - 关键文件: `tauri.conf.json`
  - 优先级: 高 | 预估: 0.5天
  - 验收标准: `build.distDir` 指向现有 Web 项目的根目录。`allowlist` 配置正确。

- [x] 1.4 初始化移动端项目 (Android)
  - 关键文件: `src-tauri/gen/android` 目录结构
  - 优先级: 高 | 预估: 1天
  - 验收标准: Android 项目能够成功生成，并能在模拟器或真机上运行空白 Tauri 应用。

- [x] 1.5 初始化移动端项目 (iOS)
  - 关键文件: `src-tauri/gen/ios` 目录结构
  - 优先级: 高 | 预估: 1天
  - 验收标准: iOS 项目能够成功生成，并能在模拟器或真机上运行空白 Tauri 应用。
- [ ] 1.6 配置 iOS 代码签名
  - 关键文件: `tauri.conf.json` (bundle > iOS > developmentTeam), Apple Developer Account
  - 优先级: 中 | 预估: 0.5天
  - 验收标准: Xcode 项目可以成功签名，应用可以在真机上初步运行（如果需要）。

## 2. 集成现有 Web 前端资源
- [x] 2.1 复制 Web 文件到 `distDir`
  - 关键文件: `distDir` 目录 (例如: `src-web` 或 `public`)
  - 优先级: 高 | 预估: 0.5天
  - 验收标准: 所有 HTML, CSS, JS 文件已复制到指定目录。

- [x] 2.2 修改 `index.html`
  - 关键文件: `index.html`
  - 优先级: 中 | 预估: 0.5天
  - 验收标准: 移除或本地化 CDN 依赖，确保路径正确。

- [ ] 2.3 运行并验证 Web UI
  - 关键命令: `cargo tauri dev`, `cargo tauri android dev`, `cargo tauri ios dev`
  - 优先级: 高 | 预估: 1天
  - 验收标准: Web UI 在 Tauri 桌面和移动端能基本显示，但功能不完整。
- [x] 2.3.1 (Rust) 修复 `tauri-plugin-log` 初始化导致的 Rust panic (高优先级)
  - 关键文件: `src-tauri/src/main.rs`
  - 验收标准: 应用在 Android 上启动不再出现日志插件相关的 panic。
- [x] 2.3.2 (JS) 修复 `js/app.js` 中的 `require is not defined` 错误 (中优先级)
  - 关键文件: `public/js/app.js`
  - 验收标准: WebView 控制台不再报告 `require is not defined` 错误。
- [x] 2.3.3 (Web) 调查并修复 Service Worker 注册失败的问题 (低优先级)
  - 关键文件: `public/service-worker.js`, `public/index.html`
  - 验收标准: Service Worker 能够成功注册或明确移除。
- [x] 2.3.4 (JS) 修复 `version-check.js` 获取版本错误的问题 (低优先级)
  - 关键文件: `public/js/version-check.js`
  - 验收标准: 版本检查功能按预期工作或被调整。
- [ ] 2.3.5 (Web) 调查 Tailwind CDN 警告 (可选, 极低优先级)
  - 关键文件: `public/libs/tailwindcss.min.js`
  - 验收标准: 明确警告原因，必要时采取措施。

[注: 由于篇幅限制，这里只展示了部分任务。实际文件中会包含所有任务列表]
