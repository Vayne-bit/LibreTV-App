# LibreTV

免费、无广告的影视聚合搜索与播放应用，支持安卓手机、安卓平板和 Windows 电脑，装上就能用，不需要部署服务器。

本项目基于 [KeyRotate/LibreTV-App](https://github.com/KeyRotate/LibreTV-App)（[LibreSpark/LibreTV](https://github.com/LibreSpark/LibreTV) 的 Tauri 2 客户端版本）改造：换用 B 站风格的 ArtPlayer 播放器，修复全屏和封面加载问题，并参考爱奇艺、B 站 App 重做了手机和平板布局。

## 下载安装

到 [Releases 页面](https://github.com/Vayne-bit/LibreTV-App/releases/latest) 下载最新版本：

| 平台 | 文件 | 说明 |
|---|---|---|
| 安卓手机 / 平板 | `LibreTV_<版本>_android_universal.apk` | 安卓 7.0 及以上，一个包通用所有设备 |
| Windows | `LibreTV_<版本>_x64-setup.exe` | Windows 10 / 11（64 位），推荐 |
| Windows | `LibreTV_<版本>_x64_en-US.msi` | 和 exe 二选一 |

- 安卓安装时如果提示"未知来源"，在弹窗里允许即可。新版本可以直接覆盖安装，历史记录和设置会保留。
- Windows 首次运行可能弹出 SmartScreen"未知发布者"，点"更多信息" →"仍要运行"。Windows 10 如果没有 WebView2，安装程序会自动下载。

## 功能

**首页**
- 顶部频道：推荐 / 电影 / 电视剧 / 动漫 / 综艺 / 纪录片。
- 推荐页有轮播大图，下面按热门电影、热门剧集、高分佳作、国产剧、热门动漫、热门综艺、最新电影、美剧、韩剧分组横排展示，每组可以点"更多"。
- 频道页可以按类型、地区、年份、排序筛选，滑到底自动加载。
- 推荐数据来自豆瓣，可以在设置里关闭。

**搜索**
- 同时搜索多个视频源，结果边搜边显示，可以按来源筛选。
- 显示最近搜索和热搜。

**详情与选集**
- 多条播放线路切换，集数多时每 50 集一组，支持正序 / 倒序、复制播放链接。
- 看过的剧集会显示"继续看"。

**播放器**（[ArtPlayer](https://github.com/zhw2590582/ArtPlayer) + hls.js + mpegts.js）
- 支持 m3u8、FLV、MP4 等格式。
- 全屏：安卓上进入沉浸式全屏并按视频方向自动横屏，返回键先退出全屏；Windows 上整个窗口全屏。
- 左右滑动调进度、长按 3 倍速、倍速播放、锁屏、画面比例 / 翻转 / 填充模式切换，Windows 上支持画中画。
- 按住进度条拖动时，画面中央显示目标时间和总时长，松手后自动消失。
- 下一集按钮、自动连播、记住播放进度并自动续播。
- **跳过片头**：按剧名分别记住片头长度，下次播这部剧的任何一集都自动跳过。全屏顶部条上有「以当前位置为片头结束」按钮，播放器设置面板里也能点。
- **广告过滤**：按播放列表结构识别插入的广告分片并整块删除，不是靠时间戳碰运气（可在设置里关闭）。
- **缓冲深度**可选自动 / 浅（起播快）/ 深（抗卡顿），单码率片源自动用深缓冲。
- **卡顿自动换源**：一分钟内卡顿达到 6 次时自动换源，最多换 2 次；还能降档时优先降档，不换源。
- 全屏顶部信息条显示标题、时间、电量，下载和片头标记两个按钮也在这条上。

**历史记录**
- 按今天 / 昨天 / 更早分组，显示观看进度，点击直接续播。

**离线下载**
- 选集列表每一集后面有下载角标，播放器全屏顶部条也有下载按钮。
- 「下载本季」一次把整季加入队列，最多同时下 2 集，每集内部 4 个分片并发。
- 下载时自动剔掉广告分片，存的是干净的正片。
- 已下过的分片会跳过，中断后自动接着下（换页面也会继续）。
- 「我的 → 下载」里显示进度、速度、剩余时间、错误原因，支持单条删除、多选删除、全部清空，点一下直接播放。

**分片缓存**
- 看过的分片会存到本地，回看和重看同一集时不用重新下载，上限 2GB，按最近使用淘汰。
- 可以在设置里关掉，也可以单独清空。

**跨设备同步**（可选，通过坚果云 WebDAV）
- 在多台设备之间同步观看进度、收藏和同步记录。
- 删除记录后会保留删除标记 90 天，不会被其它设备合并回来。
- 设置页有同步码、设备列表和同步记录。

**设置**
- 勾选或自定义视频源接口，黄色内容过滤、去广告、豆瓣推荐、分片缓存开关。
- 存储管理：查看离线下载和分片缓存的实际占用，分别清空。
- 配置导入 / 导出。
- 诊断信息：播放列表结构、上次播放的缓冲与卡顿数据、画面尺寸与错误码、设备兼容性等，遇到问题可以直接复制出来。

**多设备适配**
- 手机用底部导航栏；平板横屏和电脑改为左侧导航栏，播放页变成左边视频、右边选集的两栏布局。
- 海报网格随屏幕宽度从 3 列到 8 列自动调整，适配刘海屏，安卓支持分屏。
- 封面图通过应用内置的图片代理加载，解决防盗链导致的封面不显示。
- 内核较老的设备（Chrome 88 以前，部分车机和电视盒子的 WebView 停在这里）做了兜底：播放器高度和封面比例不再塌成 0，`inset` 简写和 `dvh` 单位也补了等价写法。这些兜底只在老内核上生效，现代内核行为不变。

### Windows 快捷键

| 按键 | 作用 |
|---|---|
| 空格 | 播放 / 暂停 |
| ← / → | 快退 / 快进 |
| ↑ / ↓ | 音量 |
| F | 全屏 |
| Alt + ← / → | 上一集 / 下一集 |
| Esc | 退出全屏 |

## 开发

前端在 `public/`（原生 HTML / CSS / JavaScript），后端在 `src-tauri/`（Rust，负责网络请求转发、封面图片代理和窗口全屏）。

**只看界面布局**（不需要 Rust）：

```bash
npm install
npm run serve:public   # 打开 http://localhost:3000
```

浏览器里没有 Rust 后端，搜索结果、豆瓣推荐和封面不会显示，只能用来看布局。

**完整运行桌面版**：先安装 [Rust](https://www.rust-lang.org/tools/install) 和 Visual Studio Build Tools（勾选"使用 C++ 的桌面开发"），然后：

```bash
npm install
npx tauri dev
```

更多本地构建方式见 [BUILDING.md](BUILDING.md)。

## 云端打包与发版

打包全部在 GitHub Actions 上完成，本机不需要安卓环境：

- **发正式版**：推送 `v` 开头的标签，例如 `git tag v1.1.1 && git push origin v1.1.1`。`build.yml` 会同时打出安卓 APK 和 Windows 安装包，并自动创建 Release。标签号就是应用版本号，需要是纯数字的 `x.y.z`。
- **临时测试**：在 Actions 页面手动运行 **Build**，到运行详情的 Artifacts 里下载，不会创建 Release。

安卓签名使用仓库 Secrets 里的 `ANDROID_KEYSTORE`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`，可以用 **Generate Android keystore** 工作流生成，详见 [BUILDING.md](BUILDING.md)。签名密钥要另外备份好，丢失后新版本就无法覆盖安装旧版本。

## 项目结构

```
public/                         前端
  index.html                    首页、搜索、历史、设置
  player.html                   播放页
  js/  css/  libs/
src-tauri/                      Tauri / Rust 后端
  src/lib.rs                    网络请求、封面代理、窗口全屏
  android-overrides/            安卓原生改动（全屏、沉浸式、返回键）
scripts/apply-android-overrides.mjs   打包时把安卓改动覆盖进生成的安卓工程
.github/workflows/
  build.yml                     安卓 + Windows 打包并发布
  gen-keystore.yml              生成安卓签名密钥
```

## 致谢

- [LibreSpark/LibreTV](https://github.com/LibreSpark/LibreTV)：原始项目
- [KeyRotate/LibreTV-App](https://github.com/KeyRotate/LibreTV-App)：Tauri 客户端版本
- [Tauri](https://tauri.app/)、[ArtPlayer](https://github.com/zhw2590582/ArtPlayer)、[hls.js](https://github.com/video-dev/hls.js)、[mpegts.js](https://github.com/xqq/mpegts.js)

## 免责声明

本应用仅作为视频搜索工具，不存储、上传或分发任何视频内容。所有视频均来自第三方接口提供的搜索结果，如有侵权内容，请联系相应的内容提供方。

开发者不对使用本应用产生的任何后果负责，使用时请遵守当地法律法规。

### 使用场景

本应用面向手机、平板和电脑设计。在车机、电视盒子等其它设备上运行时，属于这些设备使用标准 Android WebView 带来的兼容性结果，不是针对这些设备的适配，也没有经过实机验证。

**请勿在驾驶机动车或操作其它需要集中注意力的设备时使用本应用。**

## 许可证

[Apache 2.0](LICENSE)
