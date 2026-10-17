# BookTV：老笔记本当影视服务器的完整部署指南

> 目标：老笔记本做"下载 + 媒体库"，电视用 Jellyfin 看片。
>
> 硬件参考：i5-8 代 / GTX 1050Ti / 16G 内存 / 100G + 500G 固态 / Windows
> 电视参考：TCL 85Q6H（Google TV，可装 APK）

---

## 零、先理解整体架构

```
┌──────────────────────────────────────────────────────────┐
│  老笔记本（Windows，24 小时开机）                          │
│                                                          │
│  ┌────────────────────┐      ┌────────────────────────┐  │
│  │ BookTV-Server      │      │ Jellyfin               │  │
│  │ 端口 8080          │      │ 端口 8096              │  │
│  │                    │      │                        │  │
│  │ · 搜索影视          │      │ · 扫描 D:\VideoLib     │  │
│  │ · 下载 m3u8        │─────►│ · 刮削海报             │  │
│  │ · ffmpeg 合并      │ 存盘  │ · 提供播放             │  │
│  └────────────────────┘      └───────────┬────────────┘  │
│                                          │               │
│  D:\VideoLib\   ← 视频库（500G 固态）     │               │
└──────────────────────────────────────────┼───────────────┘
                                           │ 局域网
                        ┌──────────────────┴──────────────┐
                        │                                 │
                   ┌────▼─────┐                    ┌──────▼──────┐
                   │ 电视      │                    │ 新电脑/手机  │
                   │ Jellyfin  │                    │ 浏览器访问   │
                   │ App       │                    │ 8096 / 8080 │
                   └───────────┘                    └─────────────┘
```

**两个服务，各司其职：**

| 服务 | 端口 | 作用 | 谁用 |
|---|---|---|---|
| **BookTV-Server** | 8080 | 搜索 + 下载 | 你（在电脑上操作） |
| **Jellyfin** | 8096 | 媒体库 + 播放 | 电视、新电脑、手机 |

---

## 一、老笔记本准备

### 1.1 建视频库目录

```powershell
# 建议放在 500G 固态
New-Item -ItemType Directory -Force -Path "D:\VideoLib"
New-Item -ItemType Directory -Force -Path "D:\VideoLib\电影"
New-Item -ItemType Directory -Force -Path "D:\VideoLib\电视剧"
New-Item -ItemType Directory -Force -Path "D:\VideoLib\临时"
```

**目录用途：**

| 目录 | 用途 |
|---|---|
| `D:\VideoLib\电影` | 下载的电影 |
| `D:\VideoLib\电视剧` | 下载的剧集（每部剧一个子目录） |
| `D:\VideoLib\临时` | 下载中的分片，合并完自动清理 |

### 1.2 安装 ffmpeg

ffmpeg 是合并 m3u8 分片的必需工具。

**方式 A：用 winget（推荐，Win10/11 自带）**

```powershell
winget install Gyan.FFmpeg
```

装完**关掉当前终端重新打开**，验证：

```powershell
ffmpeg -version
```

**方式 B：手工安装（winget 不可用时）**

1. 打开 https://www.gyan.dev/ffmpeg/builds/
2. 下载 `ffmpeg-release-essentials.zip`
3. 解压到 `C:\ffmpeg`
4. 把 `C:\ffmpeg\bin` 加入系统环境变量 `PATH`
5. 重新打开终端，验证 `ffmpeg -version`

### 1.3 安装 Node.js

BookTV-Server 和 Jellyfin 的下载器都需要 Node。

```powershell
winget install OpenJS.NodeJS.LTS
```

验证：

```powershell
node -v
npm -v
```

> 如果老笔记本已经装了 Node，跳过这步。

### 1.4 安装 git

用来拉代码，不用手工拷贝。

```powershell
winget install Git.Git
```

### 1.5 确认局域网 IP

电视需要这个 IP 才能访问。

```powershell
ipconfig
```

找到你的当前网卡，记下 `IPv4 地址`，例如 `192.168.1.100`。

**建议在路由器里给笔记本绑定固定 IP**（DHCP 静态分配），否则重启后 IP 变了，电视就连不上了。

---

## 二、安装 Jellyfin

### 2.1 下载安装包

**官方下载页**：https://jellyfin.org/downloads/windows

**直接下载链接**（x64 安装版）：
https://repo.jellyfin.org/files/server/windows/stable/amd64/jellyfin_12.2.0-windows-x64.exe

> 截至 2026-10 最新稳定版是 **12.2**。版本号会变，如果上面的链接 404，
> 去官方下载页找最新的 `windows-x64.exe`。

### 2.2 安装

1. 双击运行安装程序
2. 一路"下一步"
3. 安装完成后，Jellyfin 会**自动注册为 Windows 服务**（开机自启）
4. 浏览器打开 `http://localhost:8096`

### 2.3 初始化配置

首次访问会进入设置向导：

| 步骤 | 选择 |
|---|---|
| 语言 | 中文（简体） |
| 用户名 / 密码 | 自己设一个（电视端要用） |
| **媒体库类型** | **电影** → 添加文件夹 `D:\VideoLib\电影` |
| | **显示（电视剧）** → 添加文件夹 `D:\VideoLib\电视剧` |
| 元数据语言 | Chinese |
| 国家 | China |
| 启用远程访问 | 是（局域网要能访问） |

### 2.4 关键设置：开启硬件转码（你有 1050Ti）

进入 **控制台 → 播放 → 转码**：

| 项 | 设置 |
|---|---|
| 启用硬件加速 | ✅ 勾选 |
| 硬件加速类型 | **NVIDIA NVENC** |
| 启用硬件解码 | ✅ 全部勾选（H.264 / HEVC / VP9 等） |
| 启用硬件编码 | ✅ H.264 / HEVC |

**然后重启 Jellyfin 服务：**

```powershell
Restart-Service JellyfinServer
```

> 注意：Jellyfin 的 Windows 服务名通常是 `JellyfinServer`。
> 用 `Get-Service *jellyfin*` 确认实际名称。

**为什么开这个**：如果电视不支持某些格式，Jellyfin 会转码。软转码很吃 CPU，开了 NVENC 后由显卡处理，几乎无压力。

### 2.5 确认 Jellyfin 在跑

```powershell
Get-Service *jellyfin*
```

状态应为 `Running`。

---

## 三、安装 BookTV-Server（搜索 + 下载）

> ⚠️ **这一部分还没写完。** 代码需要我来实现，目前还没有。
> 下面描述的是**目标形态**和**一旦做好后的使用方式**。

### 3.1 部署（代码完成后）

```powershell
cd D:\
git clone https://github.com/Vayne-bit/LibreTV-App.git
cd LibreTV-App
git checkout BookTV-Server   # 分支名待定
cd server
npm install
```

### 3.2 启动

```powershell
node server.mjs
```

或者注册成 Windows 服务（开机自启，待实现）。

### 3.3 使用

浏览器打开 `http://localhost:8080`：

```
┌────────────────────────────────────────┐
│  搜索：[ 沙丘2              ]  [搜索]   │
├────────────────────────────────────────┤
│  ┌──────┐ 沙丘2                         │
│  │ 海报 │ 2024 · 科幻                   │
│  │      │ 资源A  720p  [选择]           │
│  └──────┘ 资源B  1080p [选择]           │
│                                        │
│  ┌──────┐ 另一部片...                   │
│  └──────┘                              │
└────────────────────────────────────────┘
```

点「选择」进入详情，选集，点「下载」：

```
下载中：沙丘2 第01集
[████████░░░░░░░░] 52%   212/404 MB
预计剩余：1 分 20 秒
```

下载完成后**自动存到** `D:\VideoLib\电影\沙丘2.2024.mp4`，
Jellyfin 会在几分钟内（或手动扫描后）发现。

---

## 四、新电脑 / 电视怎么访问

### 4.1 先确认能 ping 通

在任何一台设备上（电视除外，它没有终端）：

```powershell
# 新电脑
ping 192.168.1.100
```

> 把 `192.168.1.100` 换成你的笔记本实际 IP。

**ping 不通说明：**
- 不在同一个 WiFi/网段
- Windows 防火墙拦了
- 笔记本的 IP 变了

**放行防火墙**（在笔记本上执行，管理员权限）：

```powershell
New-NetFirewallRule -DisplayName "Jellyfin" -Direction Inbound -LocalPort 8096 -Protocol TCP -Action Allow
New-NetFirewallRule -DisplayName "BookTV" -Direction Inbound -LocalPort 8080 -Protocol TCP -Action Allow
```

### 4.2 新电脑访问

**浏览器直接打开：**

```
Jellyfin：      http://192.168.1.100:8096
BookTV：       http://192.168.1.100:8080      （搜索下载用）
```

**或者装 Jellyfin 桌面客户端**：
https://jellyfin.org/downloads/ （Windows 版 Jellyfin Media Player）

> **这就是你要的"另一台电脑验证"** —— 浏览器打开 8096，界面、播放、海报和电视上完全一样。
> 唯一感受不到的是遥控器方向键的焦点移动（浏览器用鼠标）。

### 4.3 电视访问（TCL 85Q6H）

**前提**：电视是 Android TV / Google TV 系统，能装 APK。

#### 先确认电视系统

电视上打开：**设置 → 关于 → 系统信息**

| 显示 | 能否装 APK |
|---|---|
| **Android TV** / **Google TV** | ✅ 能 |
| **雷鸟系统**（TCL 子品牌） | ⚠️ 部分能，需确认是否基于 Android |
| 其他（Tizen / webOS） | ❌ 不能，走方式 C |

#### 电视端 APK：Jellyfin for Android TV

| 项 | 值 |
|---|---|
| **版本** | **v0.19.10**（2026-08-16 发布） |
| 文件名 | **`jellyfin-androidtv-v0.19.10-release.apk`** |
| 大小 | **20.9 MB** |
| 仓库 | https://github.com/jellyfin/jellyfin-androidtv |

> ⚠️ 不要下 `-debug.apk`（27.1 MB），那是调试版。

**下载地址（三选一）：**

1. **GitHub 发布页（推荐，能看到更新说明）**
   ```
   https://github.com/jellyfin/jellyfin-androidtv/releases/latest
   ```
   页面往下找 **Assets** → 点 `jellyfin-androidtv-v0.19.10-release.apk`

2. **GitHub 直链**（复制到浏览器地址栏）
   ```
   https://github.com/jellyfin/jellyfin-androidtv/releases/download/v0.19.10/jellyfin-androidtv-v0.19.10-release.apk
   ```

3. **官方 Jellyfin 仓库**（GitHub 下不动时试这个）
   ```
   https://repo.jellyfin.org/files/client/android-tv/
   ```
   按版本号进目录找 `release` APK

**下载后核对文件大小**（应该是 20.9 MB 左右）：

```powershell
Get-Item .\jellyfin-androidtv-v0.19.10-release.apk | Select-Object Name, @{N='MB';E={[math]::Round($_.Length/1MB,1)}}
```

#### 方式 A：从电视应用商店装（最简单，先试这个）

1. 电视打开 **Google Play Store**
2. 搜索 **Jellyfin**
3. 点安装
4. 打开，输入 `http://192.168.1.100:8096`

> **国行电视的 Google Play 可能不可用**（未预装或被限制）。
> 试一下，搜不到就走方式 B。

#### 方式 B：U 盘侧载 APK

```
1. 电脑下载上面的 release.apk
2. 拷到 U 盘（FAT32 / exFAT 格式，电视才认）
3. U 盘插到电视
4. 电视打开文件管理器（TCL 一般叫「文件管理」或「媒体中心」）
5. 找到 apk，双击安装
6. 提示「禁止安装未知来源」时：
   设置 → 安全 → 安装未知应用 → 允许「文件管理」
```

#### 方式 C：如果装不了任何 App

用电视自带浏览器打开：

```
http://192.168.1.100:8096
```

Jellyfin 有 Web 版，能用，但遥控器操作体验差（网页是按鼠标设计的）。

#### 电视端首次连接

1. 打开 Jellyfin
2. 服务器地址填 `http://192.168.1.100:8096`
   （换成你笔记本实际 IP，用 `ipconfig` 查）
3. 输入你在第 2.3 步设置的**用户名和密码**
4. 完成，看到海报墙

---

## 五、完整使用流程

```
1. 新电脑 / 笔记本浏览器打开 http://192.168.1.100:8080
2. 搜片名 → 选资源 → 点下载
3. 等进度条走完（404MB / 47分钟的一集约 1-3 分钟）
4. Jellyfin 自动发现新文件（或手动扫描）
5. 电视打开 Jellyfin → 看到新片 → 点播放
```

### 手动触发媒体库扫描

如果 Jellyfin 没自动发现：

**控制台 → 媒体库 → 扫描所有媒体库**

或者命令行：

```powershell
# 需要 Jellyfin API key，一般用界面操作就行
```

---

## 六、常见问题

### Q1：播放时卡顿

**先看 Jellyfin 是否在转码。**

播放时打开 Jellyfin 控制台 → 仪表板 → 正在播放，看那个条目：

| 显示 | 含义 | 处理 |
|---|---|---|
| **Direct Play**（直接播放） | 电视自己解码 | ✅ 正常，不会卡 |
| **Transcode**（转码） | 服务器转码 | ⚠️ 检查 GPU 是否启用 |

**如果转码且卡：**
1. 确认 `控制台 → 播放 → 转码` 里 NVENC 已开启
2. 检查任务管理器，Jellyfin 是否在用 GPU
3. 更新显卡驱动

**根治办法**：下载时就选电视支持的格式（H.264 + AAC，mp4 容器）。

### Q2：电视找不到服务器

```powershell
# 在笔记本上确认 IP
ipconfig

# 在电视上用浏览器访问测试
http://192.168.1.100:8096
```

- 确认电视和笔记本在**同一个 WiFi**
- 确认防火墙已放行 8096
- 有些路由器开了"AP 隔离"，会禁止设备互访，需在路由器设置里关闭

### Q3：下载速度慢

- m3u8 分片是**串行**下载的话很慢，后续实现会做**8 线程并发**
- 采集站本身有限速，快不了
- 404MB 的视频，正常 1-3 分钟

### Q4：文件下载了但 Jellyfin 看不到

1. 确认文件在 `D:\VideoLib\电影` 或 `D:\VideoLib\电视剧`
2. 确认扩展名是 `.mp4`
3. 手动扫描：控制台 → 媒体库 → 扫描所有媒体库
4. 检查媒体库路径配置是否正确

### Q5：海报不对 / 没海报

**Jellyfin 靠文件名识别影片**，命名规范很重要：

| ❌ 不好 | ✅ 好 |
|---|---|
| `40829_dda2dd73.mp4` | `沙丘2.2024.mp4` |
| `第1集.mp4` | `沙丘2.2024.S01E01.mp4` |

**电视剧目录结构：**

```
D:\VideoLib\电视剧\
└─ 沙丘2 (2024)\
   ├─ Season 1\
   │  ├─ 沙丘2.S01E01.mp4
   │  └─ 沙丘2.S01E02.mp4
```

### Q6：老笔记本关机了怎么办

Jellyfin 和 BookTV-Server 都在笔记本上，**关机就全停**。

- 笔记本开机后，Jellyfin 会自动启动（Windows 服务）
- BookTV-Server 需要手动启动，或后续做成服务

### Q7：磁盘满了

500G 大约能存：
- 电影（720p，2-4G）：**约 120-250 部**
- 电视剧（720p，400M/集）：**约 1200 集**

满了就删旧的，或者加硬盘。

---

## 七、性能预期（基于实测数据）

实测片源：`https://super.ffzy-online6.com/20260911/40829_dda2dd73/index.m3u8`

| 指标 | 实测值 |
|---|---|
| 分辨率 | 1280×720 |
| 时长 | 47.2 分钟 |
| 分片数 | 708 |
| 总大小 | **404 MB** |
| **平均码率** | **1.2 Mbps** |

**播放带宽需求：**

| 网络 | 占用率 |
|---|---|
| 百兆网线 | 1.2% |
| WiFi 5 (5G) | 0.3% |
| 千兆网线 | 0.1% |

**结论：网络绝对不是瓶颈。** 只要 Jellyfin 是 Direct Play，就不会因为网络卡顿。

---

## 八、待完成事项

| 项 | 状态 |
|---|---|
| ffmpeg 下载验证 | ⏳ **需要你在笔记本上跑一次**（见下方） |
| BookTV-Server 代码 | ❌ 未实现 |
| 下载器（并发 + 断点续传） | ❌ 未实现 |
| 自动开机启动 | ❌ 未实现 |

### 先做这一步验证

**在你老笔记本上跑：**

```powershell
ffmpeg -headers "Referer: https://super.ffzy-online6.com/`r`nUser-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" -i "https://super.ffzy-online6.com/20260911/40829_dda2dd73/index.m3u8" -c copy -bsf:a aac_adtstoasc "D:\VideoLib\电影\沙丘2.2024.mp4"
```

**预期结果**：1-3 分钟，生成约 404MB 的 mp4，能正常播放。

**如果成功** → 整条链路成立，我开始写 BookTV-Server。
**如果报错** → 把完整报错发给我。

---

## 附：已验证的技术细节

以下是我本机实测确认的（2026-10-17）：

| 项 | 结果 |
|---|---|
| master playlist | ✅ HTTP 200，指向 1280×720 |
| 子播放列表 | ✅ 708 个分片，`#EXT-X-PLAYLIST-TYPE:VOD` |
| **是否加密** | ✅ **未加密**（无 `#EXT-X-KEY`） |
| 分片下载 | ✅ HTTP 200，584KB，TS 同步字节 `0x47` 正确 |
| **防盗链要求** | **必须带 `Referer: https://super.ffzy-online6.com/`** |
| ⚠️ 重要发现 | PowerShell 的 `Invoke-WebRequest` 全部 403，**只有 curl 那套头能过**。说明防盗链还检查了其他请求头，实现下载器时要照抄 curl 的头 |

### 关于下载 APK 时的网络限制

我在本机测试了到 GitHub 的连通性：

| 域名 | 状态 |
|---|---|
| `api.github.com` | ✅ 200（可查 release 信息） |
| `github.com` | ❌ 超时 |
| `objects.githubusercontent.com` | ⚠️ 404 |
| `repo.jellyfin.org` | ✅ 200 |

**GitHub 的 release 下载走 `github.com` + `objects.githubusercontent.com`**，
所以**如果下载 APK 超时或失败**，不是链接错了，是网络原因。改用：

- `repo.jellyfin.org` 的官方仓库链接
- 或者网络代理 / 换网络环境
- 或者在有正常 GitHub 访问的机器上下好，再拷 U 盘

> 你本机能不能下，我没法替你验证——**请以你实际下载结果为准**。
