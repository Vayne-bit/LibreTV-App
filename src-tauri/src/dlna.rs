// DLNA/UPnP 投屏模块（Tauri 层，Android/Windows 通用）
//
// 组成：
// 1. SSDP 组播搜索局域网内的 DLNA 渲染设备（MediaRenderer）
// 2. AVTransport SOAP 控制：SetAVTransportURI / Play / Seek / Stop
// 3. 本地防盗链代理：源站需要 Referer/User-Agent/Cookie 时，本机起一个轻量
//    HTTP 服务，电视直接拉本地代理，代理带上鉴权头去源站取流并转发。
//    m3u8 播放列表会被改写：分片/密钥/子列表地址全部指向本地代理，整条链路
//    （列表 -> 分片 -> 密钥）都经过代理，防盗链源可完整投屏。
//
// 依赖刻意收敛在仓库已有 crate（tokio / reqwest / serde / once_cell）加极小的 if-addrs，
// 不引入重型依赖。SSDP 用 std UdpSocket 组播（逐网卡发搜索，兼容 Windows 多网卡）；
// Android 侧需要多播锁（MainActivity.kt 启动时 acquire），
// 并在 Manifest 声明 CHANGE_WIFI_MULTICAST_STATE（apply-android-overrides.mjs 注入）。

use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use mdns_sd::{ServiceDaemon, ServiceEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::{FsExt, FilePath, OpenOptions};

// ---------- 数据结构 ----------

#[derive(Serialize, Debug, Clone)]
pub struct DlnaDevice {
    pub name: String,
    pub control_url: String,
    pub location: String,
    /// 投屏协议：dlna（标准安卓/三星电视内置渲染端）| airplay（Apple TV / 支持 AirPlay 的电视）
    pub protocol: String,
}

#[derive(Clone, Debug)]
struct Upstream {
    referer: Option<String>,
    user_agent: Option<String>,
    cookie: Option<String>,
    /// 会话令牌：代理路径必须携带，防止局域网内其他主机把本机当公开跳板用
    token: String,
    /// 是否为三星 Tizen 渲染端。三星 DMR 固定用 9197 端口，且对 MPEG-TS 要求声明
    /// video/vnd.dlna.mpeg-tts（标准 DLNA 专用 MIME）；标准安卓 DLNA 渲染端更认
    /// video/mp2t。两者 DIDL 的 DLNA flags 与响应头一致，仅 TS 的 MIME 分流。
    is_samsung: bool,
    /// 广告过滤：前端判定好的「要删掉哪些分片 URI」。
    ///
    /// 为什么不在 Rust 侧重写一遍广告判据：判据本身（断点 + 无加密 KEY +
    /// 独立路径前缀 + 时长规整 + 安全阀）在前端已有一份实现并通过真实站源实测。
    /// Rust 再写一份就是第二套规则，两边必然漂移 —— 判错的那边会直接删掉正片。
    /// 所以这里只做执行：前端按自己的判据算出广告分片 URI 列表传下来，
    /// Rust 按列表剔除。判据的唯一归属仍是前端。
    ad_uris: Vec<String>,
}

struct ProxyState {
    base: String, // http://<lan-ip>:<port>
    token: String,
}

static PROXY: Lazy<Mutex<Option<ProxyState>>> = Lazy::new(|| Mutex::new(None));
static PROXY_SEQ: AtomicU64 = AtomicU64::new(0);
/// 代理收到的连接数（含电视的取流请求）。用于投屏失败诊断：
/// 计数为 0 = 电视根本没连上手机（AP 隔离/不同网段）；>0 = 电视可达但取流被拒。
static PROXY_CONN_COUNT: AtomicU64 = AtomicU64::new(0);

/// 代理侧最近一次「非正常断开」的原因。
///
/// 电视黑屏转圈时，连接数和设备指令都是正常的——问题发生在代理内部
/// （拉清单失败 / 上游超时 / 分片 403），而这条链路没有任何日志出口。
/// 把它挂到诊断报告上，下次出问题能直接看出是哪个环节断的。
static PROXY_LAST_ERROR: Lazy<Mutex<String>> = Lazy::new(|| Mutex::new(String::new()));

fn record_proxy_error(err: String) {
    // 电视自己关流/切集是正常行为，不该覆盖真正的故障原因
    if err.contains("电视中断了连接") || err.contains("Broken pipe") {
        return;
    }
    if let Ok(mut guard) = PROXY_LAST_ERROR.lock() {
        *guard = err;
    }
}

fn proxy_last_error() -> String {
    PROXY_LAST_ERROR
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

fn proxy_connection_count() -> u64 {
    PROXY_CONN_COUNT.load(Ordering::Relaxed)
}

/// 本次投屏实际采用的模式与下发地址。
///
/// 诊断报告只看连接数是不够的：本地视频投屏走的是另一个服务、不经过代理，
/// 所以计数会「停在上一次流媒体投屏」的值 —— 拿它当本次投屏的状态会直接
/// 得出错误结论。把模式和下发地址一起记下来，才能说明这个数字属于哪一次。
static LAST_CAST_INFO: Lazy<Mutex<String>> = Lazy::new(|| Mutex::new(String::new()));

/// 最近一次 TS 串流会话的 token（诊断 [4] 读取该会话的连接/续传统计）。
static LAST_TS_TOKEN: Lazy<Mutex<String>> = Lazy::new(|| Mutex::new(String::new()));

fn set_last_cast_info(info: String) {
    if let Ok(mut guard) = LAST_CAST_INFO.lock() {
        *guard = info;
    }
}

fn last_cast_info() -> String {
    LAST_CAST_INFO
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

/// 电视取流被跳过的坏分片数（本次投屏期间）。
static SKIPPED_SEGMENT_COUNT: AtomicU64 = AtomicU64::new(0);

fn skipped_segment_count() -> u64 {
    SKIPPED_SEGMENT_COUNT.load(Ordering::Relaxed)
}

/// 无自定义 UA 时给上游请求补的默认 UA：部分 CDN 对空 UA / 电视 UA 返回 403。
const DEFAULT_UPSTREAM_UA: &str =
    "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

/// 生成投屏会话令牌。RandomState 每次实例化使用随机种子（标准库自带熵源），
/// 再混入纳秒时间与会话序号，无需引入随机数 crate。
fn generate_session_token() -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = RandomState::new().build_hasher();
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    hasher.write_u64(nanos);
    hasher.write_u64(PROXY_SEQ.load(Ordering::Relaxed));
    let v = hasher.finish();
    format!("{:016x}{:016x}", v, !v)
}

static HTTP: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_default()
});

/// 测试专用：CAST_MIRROR_BASE 设置时把所有上游 URL 改写到本机通用镜像。
/// 背景：沙箱环境禁止编译产物直连外网（connect 一律 os error 10013），
/// 多源端到端模拟用「Node 镜像回环」替代出网传输层——master 跟随、相对地址
/// 解析、分片拉取、TS 拼接等被测逻辑全部照旧真实。生产构建此函数是空操作。
fn mirror_url(url: &str) -> String {
    // 生产构建：原样返回（空操作）。测试构建：CAST_MIRROR_BASE 设置时把
    // 上游 URL 改写到本机镜像（沙箱禁外联，见函数上方注释）。
    // 用 cfg 块而非成对函数——成对的 #[cfg(test)] fn 会触发孤儿属性守卫。
    #[cfg(not(test))]
    {
        url.to_string() // 生产：原样返回（空操作）
    }
    #[allow(unreachable_code)]
    #[cfg(test)]
    {
        let mirror = match std::env::var("CAST_MIRROR_BASE") {
            Ok(base) if !base.trim().is_empty() => base,
            _ => return url.to_string(),
        };
        if url.starts_with("http://127.0.0.1")
            || url.starts_with("http://localhost")
            || !(url.starts_with("http://") || url.starts_with("https://"))
        {
            return url.to_string();
        }
        format!("{}/{}", mirror.trim_end_matches('/'), url)
    }
}

// ---------- Tauri 命令 ----------

/// 搜索局域网内的 DLNA 渲染设备（带 AVTransport 服务）。
#[tauri::command]
pub async fn search_dlna_devices(timeout_ms: Option<u64>) -> Result<Vec<DlnaDevice>, String> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(3000).clamp(500, 8000));
    let locations = tauri::async_runtime::spawn_blocking(move || ssdp_search_locations(timeout))
        .await
        .map_err(|e| format!("SSDP 搜索任务失败: {}", e))??;

    let mut devices = Vec::new();
    for location in &locations {
        if let Ok(device) = fetch_device_info(location).await {
            devices.push(device);
        }
    }
    // 同一台设备可能通过多个 ST 应答，按 control_url 去重
    devices.sort_by(|a, b| a.control_url.cmp(&b.control_url));
    devices.dedup_by(|a, b| a.control_url == b.control_url);
    Ok(devices)
}

/// 投屏到指定设备。
/// 采用自适应梯度：拉流模式（本地代理/电视直连）× 协议声明（按 URL 猜测/按三星支持列表），
/// 依次尝试直到设备接受；全部失败时给出带诊断线索的错误（实测三星 Tizen 返回
/// 716 Resource not found 的两类根因：电视拉不到流 / protocolInfo 不被接受）。
#[tauri::command]
pub async fn cast_to_device(
    control_url: String,
    url: String,
    title: Option<String>,
    position: Option<f64>,
    referer: Option<String>,
    user_agent: Option<String>,
    cookie: Option<String>,
    ad_uris: Option<Vec<String>>,
) -> Result<String, String> {
    let referer = referer.filter(|s| !s.trim().is_empty());
    let user_agent = user_agent.filter(|s| !s.trim().is_empty());
    let cookie = cookie.filter(|s| !s.trim().is_empty());
    // 前端判定好的广告分片 URI：投屏时电视自己拉流，浏览器侧的过滤对它无效，
    // 必须把「哪些分片是广告」带下来，代理与 TS 串流两条路径都按它剔除。
    let ad_uris: Vec<String> = ad_uris
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    // 诊断计数按「一次投屏」结算。放在投屏入口而不是代理启动处：
    // 本地视频投屏根本不启动代理，计数不会被清零，读数会停在上一次流媒体投屏，
    // 让人误以为是本次的数据。清零后「0」就能明确说明电视这次没连过代理。
    PROXY_CONN_COUNT.store(0, Ordering::Relaxed);
    SKIPPED_SEGMENT_COUNT.store(0, Ordering::Relaxed);
    set_last_cast_info(format!("进行中（目标：{}）", control_url));

    // HLS 判定：非直连容器扩展名（mp4/mkv/avi/ts/flv/webm）即按 HLS 处理，
    // 无扩展名清单地址也覆盖。三星官方支持容器不含 HLS——m3u8 无论代理还是
    // 直连下发都会被 716 拒绝，必须走 TS 串流梯度。
    let is_hls = {
        let lower = url.to_ascii_lowercase();
        let clean = lower.split(|c| c == '?' || c == '#').next().unwrap_or(&lower);
        !clean.ends_with(".mp4")
            && !clean.ends_with(".mkv")
            && !clean.ends_with(".avi")
            && !clean.ends_with(".ts")
            && !clean.ends_with(".flv")
            && !clean.ends_with(".webm")
    };

    // 拉流模式候选（按序尝试）：
    // - HLS 源：① TS 串流——代理在本地把分片拼成连续 MPEG-TS（实测三星 Tizen
    //   对 m3u8 一律 716 Resource not found，无论代理/直连/协议声明；TS 是其
    //   官方支持容器，这是唯一可行路径）；② 原样代理 m3u8（本身支持 HLS 的
    //   渲染端）；③ 电视直连
    // - 非 HLS 源：代理（补鉴权头、HTTPS 转 HTTP）→ 直连
    let modes: Vec<&str> = if is_hls {
        vec!["proxy-ts", "proxy", "direct"]
    } else {
        vec!["proxy", "direct"]
    };

    // 代理地址必须从电视可达的网卡出：设备 IP 来自 SSDP（电视真实网段），
    // 据此选同网段本机网卡；选不出再回退默认路由探测
    let proxy_ip = url_host_ip(&control_url)
        .and_then(best_local_ip_for)
        .map(|(ip, _)| ip);

    // 设备画像：三星 Tizen 用 9197 端口的 DMR，且 TS 要求 DLNA 专用 MIME；
    // 标准安卓/其他 DLNA 渲染端更认 video/mp2t。两者仅 TS 的 MIME 分流，
    // DIDL 的 DLNA flags 与代理响应头一致（都是 DLNA 1.5 标准）。
    let is_samsung = is_samsung_renderer(&control_url);

    let mut attempts: Vec<String> = Vec::new();
    let mut proxy_reached_by_tv = false;
    for mode in &modes {
        // TS 串流的内容就是 MPEG-TS：三星声明 video/vnd.dlna.mpeg-tts，
        // 标准安卓 DLNA 渲染端声明 video/mp2t（更通用）。按设备画像分流。
        let protos: Vec<Option<&str>> = if *mode == "proxy-ts" {
            vec![Some(if is_samsung {
                "video/vnd.dlna.mpeg-tts"
            } else {
                "video/mp2t"
            })]
        } else {
            vec![None]
        };
        for proto in &protos {
            let playback_url = match *mode {
                "proxy-ts" => {
                    stop_stream_proxy();
                    let upstream_arc = std::sync::Arc::new(Upstream {
                        referer: referer.clone(),
                        user_agent: user_agent.clone(),
                        cookie: cookie.clone(),
                        token: String::new(),
                        is_samsung,
                        ad_uris: ad_uris.clone(),
                    });
                    // 预热：趁 Set/Play 指令往返的间隙把清单与前几个分片拉进内存，
                    // 电视随后 GET live.ts 时立刻有数据可读（否则首字节要等
                    // 清单+首分片串行下载完，移动网络下动辄数秒）
                    let warm_target = url.clone();
                    let warm_upstream = upstream_arc.clone();
                    tauri::async_runtime::spawn(async move {
                        warm_ts_stream(warm_target, warm_upstream).await
                    });
                    let ts_token = generate_session_token();
                    let (_, ts_entry) = start_stream_proxy(
                        url.clone(),
                        ts_token.clone(),
                        referer.clone(),
                        user_agent.clone(),
                        cookie.clone(),
                        proxy_ip,
                        is_samsung,
                        ad_uris.clone(),
                    )
                    .await?;
                    if let Ok(mut guard) = LAST_TS_TOKEN.lock() {
                        *guard = ts_token;
                    }
                    ts_entry
                }
                "proxy" => {
                    stop_stream_proxy();
                    let (entry, _) = start_stream_proxy(
                        url.clone(),
                        generate_session_token(),
                        referer.clone(),
                        user_agent.clone(),
                        cookie.clone(),
                        proxy_ip,
                        is_samsung,
                        ad_uris.clone(),
                    )
                    .await?;
                    entry
                }
                _ => {
                    stop_stream_proxy();
                    url.clone()
                }
            };
            let mode_desc = match *mode {
                "proxy-ts" => "本机代理/TS串流",
                "proxy" => "本机代理",
                _ => "电视直连",
            };
            let proto_desc = proto.unwrap_or("自动");
            // 下发新 URI 前先 Stop，清掉电视上可能处于锁定/播放中的传输态
            // （baverrr/tv-remote 实证：三星在部分播放态下会拒收新 URI → 716/719）。
            // 失败忽略：首次投屏本就没有可停的传输。
            let _ = dlna_stop(&control_url).await;
            tokio::time::sleep(Duration::from_millis(300)).await;
            match dlna_set_av_transport(&control_url, &playback_url, title.as_deref(), *proto, is_samsung).await {
                Ok(()) => {
                    // Play 失败不再整体失败：部分电视收到 SetURI 就自动起播，
                    // 真实起播与否以下面的传输状态轮询为准
                    let _ = dlna_play(&control_url).await;
                    // 从当前进度续投；TS 串流是直播形态不支持 REL_TIME 续播；
                    // 部分电视不支持 REL_TIME Seek，失败不影响投屏本身
                    if let Some(pos) = position {
                        if pos > 1.0 && *mode != "proxy-ts" {
                            let _ = dlna_seek(&control_url, pos).await;
                        }
                    }
                    // 起播验证：轮询电视传输状态，把「电视真的播出来了吗」变成事实。
                    // 拒收 → 记入 attempts 并自动落到下一个投屏梯度；
                    // 缓冲中 → 不算失败（慢源/慢电视，用户侧表现是稍等起播）。
                    let verdict = verify_playback_started(&control_url).await;
                    let addr_desc = parse_http_url(&playback_url)
                        .map(|(h, p, _)| format!("{}:{}", h, p))
                        .unwrap_or_else(|| "—".to_string());
                    // 假起播识别（真机实证：三星电视上的乐播类第三方接收端会对
                    // Set/Play 一律应答成功并上报 PLAYING，却从不到本机代理取流，
                    // 随后弹二维码要求付费）。代理模式下媒体必须经本机下发，
                    // 0 连接 = 电视根本没有播我们的内容 → 该梯度按失败处理。
                    let proxy_conns = proxy_connection_count();
                    if mode.starts_with("proxy") && proxy_conns == 0 {
                        attempts.push(format!(
                            "[{}/{}] 电视上报「{}」但从未连接本机代理取流——响应不可信（常见于乐播类第三方接收端先应答再要求扫码激活，或残留旧会话状态）；建议改选带「原生」标记的设备",
                            mode_desc,
                            proto_desc,
                            if matches!(verdict, PlayVerdict::Playing) { "播放中" } else { "缓冲中" }
                        ));
                        set_last_cast_info(format!(
                            "失败 · {}（proto {}）· 电视应答正常但 0 取流连接（疑似第三方接收端要求激活）",
                            mode_desc, proto_desc
                        ));
                        continue;
                    }
                    match verdict {
                        PlayVerdict::Playing => {
                            set_last_cast_info(format!(
                                "成功 · {}（proto {}）· 下发 {} · 电视已起播（取流连接 {}）",
                                mode_desc, proto_desc, addr_desc, proxy_conns
                            ));
                            return Ok(playback_url);
                        }
                        PlayVerdict::Buffering => {
                            set_last_cast_info(format!(
                                "已下发 · {}（proto {}）· 下发 {} · 电视缓冲中（取流连接 {}；若长时间转圈请用「投屏诊断」）",
                                mode_desc, proto_desc, addr_desc, proxy_conns
                            ));
                            return Ok(playback_url);
                        }
                        PlayVerdict::Error(desc) => {
                            if mode.starts_with("proxy") && proxy_connection_count() > 0 {
                                proxy_reached_by_tv = true;
                            }
                            attempts.push(format!(
                                "[{}/{}] 电视已收到指令但拒收内容：{}（下发地址: {}）",
                                mode_desc, proto_desc, desc, addr_desc
                            ));
                            continue;
                        }
                    }
                }
                Err(e) => {
                    if mode.starts_with("proxy") && proxy_connection_count() > 0 {
                        proxy_reached_by_tv = true;
                    }
                    // 错误带上实际下发给电视的地址（只留 host:port），
                    // 一眼能看出代理 IP 是否是电视可达网段
                    let addr_desc = parse_http_url(&playback_url)
                        .map(|(h, p, _)| format!("{}:{}", h, p))
                        .unwrap_or_else(|| playback_url.chars().take(60).collect());
                    attempts.push(format!(
                        "[{}/{}] {}（下发地址: {}）",
                        mode_desc, proto_desc, e, addr_desc
                    ));
                }
            }
        }
    }

    // 全部失败：拼装带诊断线索的错误
    let mut detail = attempts.join("；");
    if modes.contains(&"proxy") && !proxy_reached_by_tv {
        detail.push_str(
            "。诊断：电视始终未能连接到手机上的代理（请确认电视与手机连的是同一个路由器，\
             且路由器未开启「AP 隔离/设备隔离/访客网络」），若路由器开启了隔离，电视将无法访问手机",
        );
    } else if proxy_reached_by_tv {
        detail.push_str(
            "。诊断：电视能连上手机代理但取流失败，多为视频源限制了非浏览器访问或地址已过期，可换一集或换数据源再试",
        );
    }
    set_last_cast_info(format!(
        "失败 · 已尝试 {} 个模式 · 电视连接代理 {} 次",
        attempts.len(),
        proxy_connection_count()
    ));
    Err(detail)
}

/// 停止投屏。
#[tauri::command]
pub async fn stop_dlna_cast(control_url: String) -> Result<(), String> {
    stop_stream_proxy();
    dlna_stop(&control_url).await
}

/// 投屏环境诊断：把「靠猜」变成「看报告」。
/// 一次性输出：本机网卡、SSDP 搜索结果、每台设备的描述解析与指令应答探测、
/// 当前视频源的本机拉流测试、本地代理状态。每一步失败都记录进报告而不中断，
/// 报告整体总是返回成功——用户复制全文给开发者即可定位问题在哪一环。
#[tauri::command]
pub async fn dlna_diagnostics(
    test_url: Option<String>,
    referer: Option<String>,
) -> Result<String, String> {
    let mut report = String::new();

    // [1] 本机网卡：判断搜索发到了哪个网段、电视是否可达
    report.push_str("[1] 本机网卡\n");
    match if_addrs::get_if_addrs() {
        Ok(list) => {
            let mut shown = 0;
            for iface in &list {
                if let if_addrs::IfAddr::V4(v4) = &iface.addr {
                    if v4.ip.is_loopback() {
                        continue;
                    }
                    report.push_str(&format!("  - {} : {}\n", iface.name, v4.ip));
                    shown += 1;
                }
            }
            if shown == 0 {
                report.push_str("  （没有发现可用的 IPv4 网卡）\n");
            }
        }
        Err(e) => report.push_str(&format!("  网卡枚举失败: {}\n", e)),
    }

    // [2] SSDP 搜索 + 设备描述解析 + 指令应答探测
    report.push_str("\n[2] SSDP 设备搜索（4 秒）\n");
    let search = tauri::async_runtime::spawn_blocking(|| ssdp_search_locations(Duration::from_secs(4)))
        .await
        .map_err(|e| format!("SSDP 搜索任务失败: {}", e))?;
    let locations = match search {
        Ok(list) => list,
        Err(e) => {
            report.push_str(&format!("  搜索失败: {}\n", e));
            Vec::new()
        }
    };
    if locations.is_empty() {
        report.push_str(
            "  未发现任何设备应答。常见原因：电视与本机不在同一网段（路由器 AP 隔离/访客网络）、\n\
             \x20 Windows 防火墙拦截入站应答（需允许本应用）、VPN/虚拟网卡分流（关掉再试）。\n",
        );
    }
    for location in &locations {
        match fetch_device_info(location).await {
            Ok(dev) => {
                report.push_str(&format!("  设备: {} (location: {})\n", dev.name, dev.location));
                // 指令应答探测：GetTransportInfo 是只读查询，不改变播放状态。
                // 它不仅说明控制通道通不通，还能读出电视当前是否 ERROR_OCCURRED
                // （= 拒收/无法解码当前媒体，正是 716 的真实原因，而非网络问题）。
                match tokio::time::timeout(
                    Duration::from_secs(6),
                    dlna_get_transport_info(&dev.control_url),
                )
                .await
                {
                    Ok(Ok((state, ts))) => {
                        if ts == "ERROR_OCCURRED" {
                            report.push_str(&format!(
                                "    控制指令应答: 正常，但传输状态异常（ERROR_OCCURRED={}）—— 电视拒收/无法解码当前媒体（编解码或容器格式问题）\n",
                                state
                            ));
                        } else {
                            report.push_str(&format!(
                                "    控制指令应答: 正常（状态: {} / {}）\n",
                                state, ts
                            ));
                        }
                    }
                    Ok(Err(e)) => report.push_str(&format!("    控制指令应答: 失败 —— {}\n", e)),
                    Err(_) => report.push_str("    控制指令应答: 超时（6 秒无响应，设备 HTTP 栈可能不稳定）\n"),
                }
                // 投屏时本地代理会用哪块网卡的地址下发给电视：必须与设备同网段才可达。
                // 这里直接算出来，报告里一眼验证「代理地址发错网卡」类问题
                // （如 VPN/蜂窝网卡抢匹配）。
                match url_host_ip(&dev.control_url).and_then(best_local_ip_for) {
                    Some((ip, bits)) => report.push_str(&format!(
                        "    投屏代理拟用本机网卡: {}（与设备 {} 前缀匹配 {} 位）\n",
                        ip,
                        url_host_ip(&dev.control_url).map(|i| i.to_string()).unwrap_or_default(),
                        bits
                    )),
                    None => report.push_str("    投屏代理拟用本机网卡: 未能确定（将回退默认路由探测，多网卡下可能不可达）\n"),
                }
            }
            Err(e) => report.push_str(&format!("  设备: {} 描述解析失败 —— {}\n", location, e)),
        }
    }

    // [3] 当前视频源的本机拉流测试
    report.push_str("\n[3] 视频源拉流测试（本机视角）\n");
    match test_url.filter(|s| !s.trim().is_empty()) {
        None => report.push_str("  （当前没有播放中的视频，跳过）\n"),
        Some(url) => {
            report.push_str(&format!("  地址: {}\n", url));
            let mut req = HTTP
                .get(&url)
                .timeout(Duration::from_secs(6))
                .header("User-Agent", DEFAULT_UPSTREAM_UA)
                .header("Range", "bytes=0-1023");
            if let Some(ref_value) = referer.clone().filter(|s| !s.trim().is_empty()) {
                req = req.header("Referer", ref_value);
            }
            match req.send().await {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    let ctype = resp
                        .headers()
                        .get("content-type")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("(未声明)")
                        .to_string();
                    report.push_str(&format!("  结果: HTTP {}，Content-Type: {}\n", status, ctype));
                    let hint = match status {
                        200 | 206 => "本机可拉流。注意：这只代表手机/电脑能拉，电视直连模式还要求电视自己也能拉到",
                        403 | 401 => "源站拒绝了本机请求（防盗链）。这类源必须走本地代理转发，投屏时会自动处理",
                        404 | 410 => "地址已失效或已过期，换一集或换数据源再试",
                        _ => "源站返回异常状态，可能是源站临时故障或限流",
                    };
                    report.push_str(&format!("  判读: {}\n", hint));

                    // 分片级拉流测试：清单能拉 ≠ 分片能拉。TS 串流要逐片下载，
                    // 分片层被防盗链/限流/加密时清单测试照样全绿，电视端却黑屏转圈。
                    // 这里跟进到媒体清单、实测首个分片的可达性与速度，把这一环补上。
                    let is_playlist = ctype.to_ascii_lowercase().contains("mpegurl")
                        || url.to_ascii_lowercase().contains(".m3u8");
                    if is_playlist && (200..300).contains(&status) {
                        report.push_str("  分片级测试:\n");
                        let upstream = Upstream {
                            referer: referer.clone().filter(|s| !s.trim().is_empty()),
                            user_agent: None,
                            cookie: None,
                            token: String::new(),
                            is_samsung: false,
                            ad_uris: Vec::new(),
                        };
                        match tokio::time::timeout(
                            Duration::from_secs(10),
                            resolve_media_playlist(&url, &upstream),
                        )
                        .await
                        {
                            Err(_) => report.push_str("    - 媒体清单解析: 超时\n"),
                            Ok(Err(e)) => {
                                // 加密 / fMP4 / 非 HLS 会在这一步暴露——这正是
                                // TS 串流梯度无法处理、投屏必然失败的源类型
                                report.push_str(&format!("    - 媒体清单解析: 失败 —— {}（该源类型 TS 串流暂不支持，投屏会自动尝试其他梯度）\n", e));
                            }
                            Ok(Ok(media_url)) => {
                                match tokio::time::timeout(
                                    Duration::from_secs(10),
                                    fetch_media_playlist(&media_url, &upstream),
                                )
                                .await
                                {
                                    Err(_) => report.push_str("    - 分片清单读取: 超时\n"),
                                    Ok(Err(e)) => report.push_str(&format!(
                                        "    - 分片清单读取: 失败 —— {}\n",
                                        e
                                    )),
                                    Ok(Ok((segments, endlist))) => {
                                        if segments.is_empty() {
                                            report.push_str("    - 分片清单为空（无可用分片）\n");
                                        } else {
                                            report.push_str(&format!(
                                                "    - 媒体清单 OK: {} 个分片（{}）\n",
                                                segments.len(),
                                                if endlist { "VOD" } else { "直播流" }
                                            ));
                                            // 首个分片 Range 试探（64KB）：只测可达性与速度，
                                            // 不整片下载（整片在慢网络下会拖住诊断）
                                            let probe_started = Instant::now();
                                            let probe_req = upstream_get(&segments[0], &upstream)
                                                .header(reqwest::header::RANGE, "bytes=0-65535");
                                            match tokio::time::timeout(
                                                Duration::from_secs(10),
                                                probe_req.send(),
                                            )
                                            .await
                                            {
                                                Err(_) => report
                                                    .push_str("    - 首分片试拉: 超时（10 秒无响应）\n"),
                                                Ok(Err(e)) => report.push_str(&format!(
                                                    "    - 首分片试拉: 失败 —— {}\n",
                                                    e
                                                )),
                                                Ok(Ok(resp)) => {
                                                    let pstatus = resp.status().as_u16();
                                                    let mut got = 0usize;
                                                    let mut body = resp;
                                                    while got < 65536 {
                                                        match tokio::time::timeout(
                                                            Duration::from_secs(10),
                                                            body.chunk(),
                                                        )
                                                        .await
                                                        {
                                                            Ok(Ok(Some(c))) => got += c.len(),
                                                            _ => break,
                                                        }
                                                    }
                                                    let secs =
                                                        probe_started.elapsed().as_secs_f64();
                                                    report.push_str(&format!(
                                                        "    - 首分片试拉: HTTP {}，取回 {} 字节 / {:.1}s（{:.0} KB/s）\n",
                                                        pstatus,
                                                        got,
                                                        secs,
                                                        got as f64 / 1024.0 / secs.max(0.001)
                                                    ));
                                                    let phint = match pstatus {
                                                        200 | 206 => {
                                                            if secs < 2.0 {
                                                                "分片可达且快，供给层正常"
                                                            } else {
                                                                "分片可达但偏慢——若供给速率低于播放速度，电视端会缓冲转圈"
                                                            }
                                                        }
                                                        403 | 401 => {
                                                            "分片被源站拒绝（分片级防盗链）——投屏必须走本地代理，黑屏转圈多半源于此"
                                                        }
                                                        404 | 410 => {
                                                            "分片已失效——播放会跳过坏片，多片连续失效则中断"
                                                        }
                                                        _ => "分片层异常状态，可能是源站限流",
                                                    };
                                                    report.push_str(&format!("    - 判读: {}\n", phint));
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Err(e) => report.push_str(&format!("  结果: 本机拉流失败 —— {}（DNS/网络/证书问题，电视同样拉不到）\n", e)),
            }
        }
    }

    // [4] 本地代理状态
    report.push_str("\n[4] 本地防盗链代理\n");
    let conns = proxy_connection_count();
    let cast_info = last_cast_info();
    if cast_info.is_empty() {
        report.push_str("  最近一次投屏: 本次启动后还没投过屏\n");
    } else {
        report.push_str(&format!("  最近一次投屏: {}\n", cast_info));
    }
    // 措辞必须点明归属：本地视频投屏不经过代理，计数会停在上一次流媒体投屏，
    // 把它当成「本次」的数据会得出完全错误的结论。
    report.push_str(&format!(
        "  电视连接代理次数（自最近一次投屏起算）: {}\n",
        conns
    ));
    let skipped = skipped_segment_count();
    if skipped > 0 {
        report.push_str(&format!(
            "  已跳过的坏分片数: {}（单分片失败不再中断投屏，画面会跳过该小段）\n",
            skipped
        ));
    }
    // TS 预热缓存状态：>0 表示投屏发起时已把前几个分片拉进内存（电视连接即可取流）；
    // 0 表示没有启用预热（本次未走 TS 串流）或已被消费/未命中
    let primed = prime_cache_size();
    report.push_str(&format!(
        "  TS 预热缓存: {} 个分片待消费（0 = 本次非 TS 串流或已被电视取走）\n",
        primed
    ));
    // TS 会话统计：连接次数含续传。三星等渐进式取流端会周期性断开重连，
    // 断点续传命中 = 重连后从电视上次收到的字节位置继续（不再从 0 重发）。
    let ts_token = LAST_TS_TOKEN.lock().map(|guard| guard.clone()).unwrap_or_default();
    if !ts_token.is_empty() {
        let state = TS_STREAM_STATES.lock().ok().and_then(|m| m.get(&ts_token).cloned());
        match state {
            Some(st) if st.connections > 0 => {
                let elapsed = st
                    .started_at
                    .map(|t| t.elapsed().as_secs_f64())
                    .unwrap_or(0.0);
                let speed = if elapsed > 1.0 && st.total_bytes > 0 {
                    format!("，平均供给 {:.0} KB/s", st.total_bytes as f64 / 1024.0 / elapsed)
                } else {
                    String::new()
                };
                report.push_str(&format!(
                    "  TS 会话: 取流连接 {} 次（断点续传 {} 次），已下发 {:.1} MB（{} 个分片序列{}）\n",
                    st.connections,
                    st.resume_hits,
                    st.total_bytes as f64 / 1048576.0,
                    st.served.len(),
                    speed
                ));
                if st.resume_hits == 0 && st.connections > 2 {
                    report.push_str("  判读: 电视多次重连但从未命中断点续传——旧版本 APK 请升级后重试\n");
                } else if elapsed > 10.0 && st.total_bytes > 0 {
                    let kbps = st.total_bytes as f64 / 1024.0 / elapsed;
                    if kbps < 250.0 {
                        report.push_str(&format!(
                            "  判读: 平均供给 {:.0} KB/s 低于常见内容码率（250~375 KB/s），电视缓冲会被喝干——\n\
                             \x20 属网络供给不足：靠近路由器/换 5GHz Wi-Fi/换播放源试试\n",
                            kbps
                        ));
                    }
                }
            }
            _ => report.push_str("  TS 会话: 本次无取流连接记录\n"),
        }
    }
    // 连接数正常、设备指令也应答，却黑屏——故障就在代理内部这一段
    let last_err = proxy_last_error();
    if last_err.is_empty() {
        report.push_str("  最近一次代理错误: 无\n");
        if conns == 0 {
            report.push_str("  判读: 电视一次都没连上代理——检查 AP 隔离/访客网络/路由器是否隔离内网设备\n");
        }
    } else {
        report.push_str(&format!("  最近一次代理错误: {}\n", last_err));
        report.push_str("  判读: 电视已连上代理，是代理去取上游时失败——这条错误即黑屏/中断的直接原因\n");
    }

    report.push_str("\n（以上全文复制发给开发者即可定位问题环节）\n");
    Ok(report)
}

/// 只读查询传输状态，返回 (CurrentTransportState, CurrentTransportStatus)。
/// CurrentTransportStatus == "ERROR_OCCURRED" 表示电视拒绝/无法播放当前媒体
/// （编解码或容器格式不被支持）——这正是 716 之后的真实原因，用来诊断而非猜测。
async fn dlna_get_transport_info(control_url: &str) -> Result<(String, String), String> {
    let envelope = soap_envelope(
        "<u:GetTransportInfo xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">\
<InstanceID>0</InstanceID></u:GetTransportInfo>",
    );
    let soap_action = "urn:schemas-upnp-org:service:AVTransport:1#GetTransportInfo";
    let (status, text) = soap_post(control_url, soap_action, &envelope).await?;
    if !(200..300).contains(&status) {
        let detail = soap_fault_desc(&text).unwrap_or_else(|| format!("HTTP {}", status));
        return Err(format!("GetTransportInfo 被拒绝: HTTP {}，{}", status, detail));
    }
    let state = xml_text(&text, "CurrentTransportState").unwrap_or_default();
    let ts = xml_text(&text, "CurrentTransportStatus").unwrap_or_default();
    Ok((state, ts))
}

// ---------- SSDP 搜索 ----------

const SSDP_MULTICAST_ADDR: Ipv4Addr = Ipv4Addr::new(239, 255, 255, 250);
const SSDP_MULTICAST_PORT: u16 = 1900;

fn ssdp_search_locations(timeout: Duration) -> Result<Vec<String>, String> {
    // Windows 桌面机普遍有 WSL/VMware/VPN 等虚拟网卡：只绑 0.0.0.0 时
    // M-SEARCH 从默认路由网卡发出，电视若在另一张网卡所在网段就收不到。
    // 这里枚举全部 IPv4 网卡，每张各开一个 socket（bind 网卡 IP + 显式指定
    // 组播出口），同一组 M-SEARCH 从所有网卡并行发出，任一路收到应答都算发现。
    let mut iface_ips: Vec<Ipv4Addr> = if_addrs::get_if_addrs()
        .map(|list| {
            list.into_iter()
                .filter_map(|iface| match iface.addr {
                    if_addrs::IfAddr::V4(v4) => Some(v4.ip),
                    if_addrs::IfAddr::V6(_) => None,
                })
                .filter(|ip| !ip.is_loopback() && !ip.is_unspecified() && !ip.is_link_local())
                .collect()
        })
        .unwrap_or_default();
    iface_ips.sort();
    iface_ips.dedup();
    if iface_ips.is_empty() {
        // 网卡枚举失败（极少见）：退回 0.0.0.0 由系统选默认路由
        iface_ips.push(Ipv4Addr::UNSPECIFIED);
    }

    let mut sockets: Vec<UdpSocket> = Vec::new();
    for ip in &iface_ips {
        let Ok(socket) = UdpSocket::bind(SocketAddr::new(IpAddr::V4(*ip), 0)) else {
            continue;
        };
        let _ = socket.set_read_timeout(Some(Duration::from_millis(200)));
        let _ = socket.set_multicast_ttl_v4(2);
        // 注：std 的 set_multicast_if_v4（IP_MULTICAST_IF）还是 unstable API，
        // stable 工具链不可用。socket 已 bind 到网卡 IP，配合下面按网卡 join，
        // 组播出口即锁定为该网卡（Linux/Windows 对源绑定组播均按所属网卡出），
        // 不需要再显式设置 IP_MULTICAST_IF。
        if ip.is_unspecified() {
            let _ = socket.join_multicast_v4(&SSDP_MULTICAST_ADDR, &Ipv4Addr::UNSPECIFIED);
        } else {
            let _ = socket.join_multicast_v4(&SSDP_MULTICAST_ADDR, ip);
        }
        sockets.push(socket);
    }
    if sockets.is_empty() {
        return Err("没有可用的网络接口，请检查网络连接后重试".to_string());
    }

    // AVTransport 是渲染设备必须的服务；MediaRenderer 与 ssdp:all 兜底
    // 只对泛型 ST 应答的设备（描述 XML 里再确认 AVTransport）。
    let targets = [
        "urn:schemas-upnp-org:service:AVTransport:1",
        "urn:schemas-upnp-org:device:MediaRenderer:1",
        "ssdp:all",
    ];
    for st in targets {
        let message = format!(
            "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: {}\r\n\r\n",
            st
        );
        for socket in &sockets {
            let _ = socket.send_to(
                message.as_bytes(),
                SocketAddr::new(IpAddr::V4(SSDP_MULTICAST_ADDR), SSDP_MULTICAST_PORT),
            );
        }
        std::thread::sleep(Duration::from_millis(60));
    }

    let mut locations = Vec::new();
    let mut buffer = [0u8; 8192];
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        for socket in &sockets {
            match socket.recv_from(&mut buffer) {
                Ok((n, _peer)) => {
                    // 头名用小写副本定位（ASCII 小写化字节长度不变，切片安全），
                    // 值必须取自原文：LOCATION 的大小写与端口是设备真实身份，
                    // 整体转小写会让部分固件的大小写敏感路径失效
                    let original = String::from_utf8_lossy(&buffer[..n]).to_string();
                    let lower = original.to_ascii_lowercase();
                    if let Some(pos) = lower.find("location:") {
                        let rest = original[pos + "location:".len()..].trim_start();
                        let end =
                            rest.find('\r').or_else(|| rest.find('\n')).unwrap_or(rest.len());
                        let location = rest[..end].trim().to_string();
                        let scheme_ok = location
                            .get(..4)
                            .map(|s| s.eq_ignore_ascii_case("http"))
                            .unwrap_or(false);
                        if scheme_ok && !locations.contains(&location) {
                            locations.push(location);
                        }
                    }
                }
                Err(_) => continue, // 读超时，轮询下一张网卡的 socket 直到截止时间
            }
        }
    }
    Ok(locations)
}

/// 拉取设备描述 XML，解析友好名称与 AVTransport controlURL。
async fn fetch_device_info(location: &str) -> Result<DlnaDevice, String> {
    let xml = HTTP
        .get(location)
        .timeout(Duration::from_secs(6))
        .send()
        .await
        .map_err(|e| format!("设备描述拉取失败: {}", e))?
        .text()
        .await
        .map_err(|e| format!("设备描述读取失败: {}", e))?;

    let name = xml_text(&xml, "friendlyName").unwrap_or_else(|| "未知设备".to_string());
    let control_path = find_avtransport_control_url(&xml).ok_or("设备不支持 AVTransport 服务")?;
    // URLBase 不可盲信：部分固件会把 URLBase 的端口写错（真实案例：Yamaha
    // WXAD-10，swyh-rs issue 同款；部分国产盒子/乐播亦有）。参照 swyh-rs 的
    // 做法：URLBase 缺失或与 SSDP location 对不上时，一律用 location 重建。
    let url_base = xml_text(&xml, "URLBase").unwrap_or_default();
    let base = effective_base(location, &url_base);
    let control_url = resolve_control_url(&base, &control_path);
    // 最终自检：拼出的地址解析不出合法端口时，先用 location 的 authority
    // 做最后兜底；仍失败则把原始数据放进错误信息，便于定位设备端问题
    if parse_http_url(&control_url).is_none() {
        let fallback = resolve_control_url(&authority_root(location), &control_path);
        if parse_http_url(&fallback).is_some() {
            return Ok(DlnaDevice {
                name,
                control_url: fallback,
                location: location.to_string(),
                protocol: "dlna".to_string(),
            });
        }
        return Err(format!(
            "controlURL 解析异常（设备描述不规范）: controlURL='{}', URLBase='{}', location='{}'",
            control_path, url_base, location
        ));
    }
    Ok(DlnaDevice {
        name,
        control_url,
        location: location.to_string(),
        protocol: "dlna".to_string(),
    })
}

/// 在服务列表里找 AVTransport 的 controlURL（ASCII 大小写不敏感）。
fn find_avtransport_control_url(xml: &str) -> Option<String> {
    let lower = xml.to_ascii_lowercase();
    let mut cursor = 0usize;
    while let Some(rel) = lower[cursor..].find("<service>") {
        let start = cursor + rel;
        let end = match lower[start..].find("</service>") {
            Some(e) => start + e,
            None => break,
        };
        let service_lower = &lower[start..end];
        if service_lower.contains("avtransport") {
            if let Some(tag_pos) = service_lower.find("<controlurl>") {
                let value_start = tag_pos + "<controlurl>".len();
                let value_end = service_lower[value_start..].find("</controlurl>")? + value_start;
                // 索引在小写副本与原文之间一一对应（ASCII 小写化不改字节长度），
                // 值从原文取出，保留大小写并解码实体
                let raw_value = &xml[start + value_start..start + value_end];
                return Some(xml_unescape(&sanitize_url_text(raw_value)));
            }
        }
        cursor = end + "</service>".len();
    }
    None
}

fn xml_text(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{}>", tag).to_ascii_lowercase();
    let close = format!("</{}>", tag).to_ascii_lowercase();
    let lower = xml.to_ascii_lowercase();
    let start = lower.find(&open)? + open.len();
    let end = lower[start..].find(&close)? + start;
    Some(xml_unescape(&sanitize_url_text(&xml[start..end])))
}

fn xml_unescape(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// 极简相对地址解析（目录相对语义，服务 m3u8 播放列表改写——HLS 分片大多是
/// 相对当前播放列表目录的路径）。绝对地址判断大小写不敏感，并剔除不可见字符。
fn resolve_url(base: &str, target: &str) -> String {
    let target = sanitize_url_text(target);
    if target.is_empty() {
        return String::new();
    }
    let lower = target.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return target.to_string();
    }
    let (scheme, rest) = match base.split_once("://") {
        Some(pair) => pair,
        None => return String::new(),
    };
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if lower.starts_with("//") {
        // scheme 相对形态（"//host/path"）
        return format!("{}:{}", scheme, target);
    }
    if target.starts_with('/') {
        return format!("{}://{}{}", scheme, authority, target);
    }
    // 相对路径：取 base 路径的目录部分
    let path = &rest[authority_end..];
    let dir_end = path
        .rfind('/')
        .map(|p| authority_end + p + 1)
        .unwrap_or(authority_end);
    format!(
        "{}://{}{}{}",
        scheme,
        authority,
        &rest[authority_end..dir_end],
        target
    )
}

/// controlURL 拼接（swyh-rs 同款语义，只服务设备控制地址，与 m3u8 改写的
/// resolve_url 区分开）：UPnP 生态里 controlURL 实际都是根相对路径，
/// 少数设备还漏掉前导 '/'。绝对地址（大小写不敏感）原样保留。
fn resolve_control_url(base: &str, target: &str) -> String {
    let target = sanitize_url_text(target);
    if target.is_empty() {
        return String::new();
    }
    let lower = target.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return target.to_string();
    }
    let (scheme, rest) = match base.split_once("://") {
        Some(pair) => pair,
        None => return String::new(),
    };
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if lower.starts_with("//") {
        return format!("{}:{}", scheme, target);
    }
    if target.starts_with('/') {
        format!("{}://{}{}", scheme, authority, target)
    } else {
        // 实测部分设备 controlURL 少了前导 '/'（swyh-rs normalize_url 同款处理）
        format!("{}://{}{}", scheme, authority, normalize_control_path(&target))
    }
}

/// 设备描述的基准地址：URLBase 仅在非空且被 SSDP location 包含时采信。
/// 端口错报/内容对不上视为固件 bug，回退到 SSDP location 的 authority
/// （swyh-rs set_location 同款规则，真实案例 Yamaha WXAD-10）。
fn effective_base(location: &str, url_base: &str) -> String {
    let url_base = sanitize_url_text(url_base);
    if !url_base.is_empty() && location.contains(url_base.as_str()) {
        url_base
    } else {
        authority_root(location)
    }
}

/// scheme://authority（不含路径）。
fn authority_root(url: &str) -> String {
    match url.find("://") {
        Some(i) => {
            let rest = &url[i + 3..];
            let end = rest.find('/').unwrap_or(rest.len());
            format!("{}://{}", &url[..i], &rest[..end])
        }
        None => String::new(),
    }
}

/// controlURL 统一为根相对形态：无前导 '/' 时补上。
fn normalize_control_path(path: &str) -> String {
    let p = path.trim();
    if p.is_empty() {
        "/".to_string()
    } else if p.starts_with('/') {
        p.to_string()
    } else {
        format!("/{}", p)
    }
}

/// 剔除 XML 文本里可能混入的 BOM/零宽字符与首尾空白（这类不可见字符
/// 会让 URL 端口校验以「invalid port number」失败）。
fn sanitize_url_text(value: &str) -> String {
    value
        .trim_matches(|c: char| {
            c.is_whitespace() || c == '\u{feff}' || c == '\u{200b}' || c == '\u{200c}' || c == '\u{200d}'
        })
        .to_string()
}

// ---------- AVTransport SOAP ----------

fn soap_envelope(body: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\
<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" \
s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body>{}</s:Body></s:Envelope>",
        body
    )
}

async fn dlna_soap_call(control_url: &str, action: &str, body: &str) -> Result<(), String> {
    let envelope = soap_envelope(body);
    let soap_action = format!("urn:schemas-upnp-org:service:AVTransport:1#{}", action);
    let (status, text) = soap_post(control_url, &soap_action, &envelope).await?;
    if !(200..300).contains(&status) {
        let detail = soap_fault_desc(&text).unwrap_or_else(|| {
            let snippet: String = text.chars().take(160).collect();
            if snippet.trim().is_empty() {
                format!("HTTP {}", status)
            } else {
                snippet
            }
        });
        return Err(format!("投屏指令({})被设备拒绝: HTTP {}，{}", action, status, detail));
    }
    // 部分设备返回 200 但体内带 UPnPError
    if text.contains("UPnPError") {
        let detail = soap_fault_desc(&text).unwrap_or_else(|| "设备返回了未知错误".to_string());
        return Err(format!("投屏指令({})被设备拒绝: {}", action, detail));
    }
    Ok(())
}

/// 发送 SOAP 指令：优先走手写 TCP 通道（SOAPAction 头名大小写规范、Connection: close；
/// reqwest/hyper 会把头名转小写发出，部分电视的 HTTP 栈对此挑剔直接拒收），
/// 传输层失败时退回 reqwest 兜底。
async fn soap_post(control_url: &str, soap_action: &str, envelope: &str) -> Result<(u16, String), String> {
    match soap_post_raw(control_url, soap_action, envelope).await {
        Ok(result) => Ok(result),
        Err(raw_err) => soap_post_reqwest(control_url, soap_action, envelope)
            .await
            .map_err(|fallback_err| format!("{}；备用通道同样失败: {}", raw_err, fallback_err)),
    }
}

async fn soap_post_raw(control_url: &str, soap_action: &str, envelope: &str) -> Result<(u16, String), String> {
    let (host, port, path) = parse_http_url(control_url).ok_or_else(|| {
        // 携带原始地址便于定位设备端描述不规范的问题
        format!("控制地址无法解析: '{}'", control_url)
    })?;
    let mut stream = tokio::time::timeout(
        Duration::from_secs(8),
        tokio::net::TcpStream::connect((host.as_str(), port)),
    )
    .await
    .map_err(|_| "连接设备超时".to_string())?
    .map_err(|e| format!("连接设备失败: {}", e))?;
    let request = format!(
        "POST {} HTTP/1.1\r\nHost: {}\r\nContent-Type: text/xml; charset=\"utf-8\"\r\nSOAPAction: \"{}\"\r\nContent-Length: {}\r\nAccept: text/xml\r\nConnection: close\r\nUser-Agent: LibreTV/1.3.7\r\n\r\n{}",
        path,
        host_header(&host, port),
        soap_action,
        envelope.len(),
        envelope
    );
    tokio::time::timeout(Duration::from_secs(8), stream.write_all(request.as_bytes()))
        .await
        .map_err(|_| "发送指令超时".to_string())?
        .map_err(|e| format!("发送指令失败: {}", e))?;
    let mut response = Vec::with_capacity(8192);
    let mut chunk = [0u8; 4096];
    loop {
        let n = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut chunk))
            .await
            .map_err(|_| "读取设备响应超时".to_string())?
            .map_err(|e| format!("读取设备响应失败: {}", e))?;
        if n == 0 {
            break;
        }
        response.extend_from_slice(&chunk[..n]);
        if response.len() > 512 * 1024 {
            break;
        }
    }
    let text = String::from_utf8_lossy(&response).to_string();
    let status_line = text.lines().next().unwrap_or_default();
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| {
            let snippet: String = text.chars().take(120).collect();
            format!("设备响应异常: {}", snippet)
        })?;
    let body_start = text.find("\r\n\r\n").map(|p| p + 4).unwrap_or(text.len());
    let body = if text.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        dechunk(&text[body_start..])
    } else {
        text[body_start..].to_string()
    };
    Ok((status, body))
}

/// reqwest 兜底通道。
async fn soap_post_reqwest(control_url: &str, soap_action: &str, envelope: &str) -> Result<(u16, String), String> {
    let response = HTTP
        .post(control_url)
        .header("SOAPAction", format!("\"{}\"", soap_action))
        .header("Content-Type", "text/xml; charset=utf-8")
        .body(envelope.to_string())
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("投屏指令发送失败: {}", e))?;
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    Ok((status, text))
}

/// 从 SOAP fault 里提取 UPnP 错误码与描述，给用户看得懂的原因。
fn soap_fault_desc(response_body: &str) -> Option<String> {
    let lower = response_body.to_ascii_lowercase();
    let code = extract_tag_value(&lower, response_body, "errorcode");
    let desc = extract_tag_value(&lower, response_body, "errordescription");
    match (code, desc) {
        (Some(c), Some(d)) => Some(format!("UPnP 错误 {}: {}", c, d)),
        (Some(c), None) => Some(format!("UPnP 错误 {}", c)),
        (None, Some(d)) => Some(d),
        (None, None) => None,
    }
}

/// lower 是原文的 ASCII 小写副本（字节长度一致），按小写定位、从原文取值。
fn extract_tag_value(lower: &str, original: &str, tag: &str) -> Option<String> {
    let open = format!("<{}", tag);
    let start = lower.find(&open)?;
    let value_start = start + lower[start..].find('>')? + 1;
    let close = format!("</{}>", tag);
    let value_end = value_start + lower[value_start..].find(&close)?;
    Some(xml_unescape(original[value_start..value_end].trim()).to_string())
}

/// 极简 http URL 解析（控制地址都是局域网 http），返回 (host 无括号, port, path)。
/// scheme 大小写不敏感（部分固件发 HTTP://），先剔除不可见字符。
fn parse_http_url(url: &str) -> Option<(String, u16, String)> {
    let url = sanitize_url_text(url);
    let lower = url.to_ascii_lowercase();
    if !lower.starts_with("http://") {
        return None;
    }
    let rest = &url[7..];
    let (authority, path) = match rest.find('/') {
        Some(pos) => (&rest[..pos], &rest[pos..]),
        None => (rest, "/"),
    };
    if authority.is_empty() {
        return None;
    }
    if let Some(stripped) = authority.strip_prefix('[') {
        // IPv6 带方括号形态
        let close = stripped.find(']')?;
        let host = stripped[..close].to_string();
        let after = &stripped[close + 1..];
        let port = match after.strip_prefix(':') {
            Some(p) => {
                let p = p.trim();
                if p.is_empty() {
                    80
                } else {
                    p.parse().ok()?
                }
            }
            None => 80,
        };
        return Some((host, port, path.to_string()));
    }
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => {
            let p = p.trim();
            if p.is_empty() {
                (h.to_string(), 80)
            } else {
                (h.to_string(), p.parse().ok()?)
            }
        }
        None => (authority.to_string(), 80),
    };
    if host.is_empty() {
        return None;
    }
    Some((host, port, path.to_string()))
}

fn host_header(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{}]:{}", host, port)
    } else if port == 80 {
        host.to_string()
    } else {
        format!("{}:{}", host, port)
    }
}

/// 解析 chunked 响应体（设备几乎都因 Connection: close 直接发原文，此为兜底）。
fn dechunk(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    loop {
        let line_end = match rest.find("\r\n") {
            Some(p) => p,
            None => break,
        };
        let size = usize::from_str_radix(
            rest[..line_end].trim().split(';').next().unwrap_or("0"),
            16,
        )
        .unwrap_or(0);
        if size == 0 {
            break;
        }
        let start = line_end + 2;
        if rest.len() < start + size {
            out.push_str(&rest[start..]);
            break;
        }
        out.push_str(&rest[start..start + size]);
        let next = start + size + 2;
        if next >= rest.len() {
            break;
        }
        rest = &rest[next..];
    }
    if out.is_empty() {
        text.to_string()
    } else {
        out
    }
}

/// 三星 Tizen 内置 DLNA 渲染端对 MIME / DLNA 标志有硬性要求（参考可正常工作的
/// baverrr/tv-remote：它按电视 GetProtocolInfo 实际广告的 MIME 声明，否则电视直接拒收）。
/// DLNA.ORG_OP=01：支持字节范围（无时间 seek）；DLNA.ORG_CI=0：未转码；
/// DLNA.ORG_FLAGS=0170...：流式传输模式、DLNA 1.5。三星会同时校验 DIDL 的 protocolInfo
/// 与代理响应头里的 contentFeatures.dlna.org，二者必须对得上，否则 716。
const SAMSUNG_DLNA_FLAGS: &str =
    "DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000";

/// 按 URL 猜测 MIME（元数据里的 protocolInfo；三星等渲染器会严格校验它）。
/// is_samsung：设备画像——三星对 TS 要求 video/vnd.dlna.mpeg-tts、对 mkv 认
/// video/x-mkv；标准安卓/其他 DLNA 渲染端更认 video/mp2t / video/x-matroska。
fn protocol_info_for(playback_url: &str, is_samsung: bool) -> &'static str {
    let lower = playback_url.to_ascii_lowercase();
    let clean = lower.split(|c| c == '?' || c == '#').next().unwrap_or(&lower);
    if clean.contains(".m3u8") {
        "application/vnd.apple.mpegurl"
    } else if clean.ends_with(".mp4") || clean.ends_with(".m4v") {
        "video/mp4"
    } else if clean.ends_with(".mkv") {
        if is_samsung {
            "video/x-mkv" // 三星 GetProtocolInfo 广告的正是 video/x-mkv
        } else {
            "video/x-matroska"
        }
    } else if clean.ends_with(".webm") {
        "video/webm"
    } else if clean.ends_with(".flv") {
        "video/x-flv"
    } else if clean.ends_with(".ts") {
        if is_samsung {
            "video/vnd.dlna.mpeg-tts" // 三星 DLNA 专用 MIME，video/mp2t 不在其支持列表 → 716
        } else {
            "video/mp2t" // 标准安卓 DLNA 渲染端更通用
        }
    } else {
        "application/vnd.apple.mpegurl" // 本应用以 m3u8 源为主
    }
}

fn build_set_uri_body(
    playback_url: &str,
    title: Option<&str>,
    with_metadata: bool,
    protocol_override: Option<&str>,
    is_samsung: bool,
) -> String {
    let safe_title = xml_escape(title.unwrap_or("LibreTV"));
    let uri = xml_escape(playback_url);
    if !with_metadata {
        return format!(
            "<u:SetAVTransportURI xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">\
<InstanceID>0</InstanceID><CurrentURI>{}</CurrentURI>\
<CurrentURIMetaData></CurrentURIMetaData></u:SetAVTransportURI>",
            uri
        );
    }
    let metadata = format!(
        "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" \
xmlns:dc=\"http://purl.org/dc/elements/1.1/\" \
xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\">\
<item id=\"0\" parentID=\"0\" restricted=\"1\">\
<dc:title>{}</dc:title><upnp:class>object.item.videoItem</upnp:class>\
<res protocolInfo=\"http-get:*:{}:{}\">{}</res>\
</item></DIDL-Lite>",
        safe_title,
        protocol_override.unwrap_or_else(|| protocol_info_for(playback_url, is_samsung)),
        SAMSUNG_DLNA_FLAGS,
        uri
    );
    // 注意：metadata 内部（title/res@protocolInfo/uri）已在各自插入处单独转义，
    // 这里必须原样嵌入，绝不能再整体 xml_escape——否则 <DIDL-Lite> 标签会被转义成
    // &lt;DIDL-Lite&gt; 文本，三星等从 CurrentURIMetaData 取播放地址的电视将解析失败。
    format!(
        "<u:SetAVTransportURI xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">\
<InstanceID>0</InstanceID><CurrentURI>{}</CurrentURI>\
<CurrentURIMetaData>{}</CurrentURIMetaData></u:SetAVTransportURI>",
        uri, metadata
    )
}

async fn dlna_set_av_transport(
    control_url: &str,
    playback_url: &str,
    title: Option<&str>,
    protocol_override: Option<&str>,
    is_samsung: bool,
) -> Result<(), String> {
    let with_meta = build_set_uri_body(playback_url, title, true, protocol_override, is_samsung);
    match dlna_soap_call(control_url, "SetAVTransportURI", &with_meta).await {
        Ok(()) => Ok(()),
        Err(first_err) => {
            // 少数设备对元数据内容挑剔（res/protocolInfo 不合口味）：退回空元数据重试一次
            let fallback = build_set_uri_body(playback_url, title, false, protocol_override, is_samsung);
            match dlna_soap_call(control_url, "SetAVTransportURI", &fallback).await {
                Ok(()) => Ok(()),
                Err(_) => Err(first_err),
            }
        }
    }
}

async fn dlna_play(control_url: &str) -> Result<(), String> {
    let body = "<u:Play xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">\
<InstanceID>0</InstanceID><Speed>1</Speed></u:Play>";
    dlna_soap_call(control_url, "Play", body).await
}

/// 起播验证轮询的次数上限（每次间隔 1 秒）。
/// 电视从 TRANSITIONING 到 PLAYING 通常 1~3 秒；慢网络下缓冲期可能更长，
/// 超出后按「缓冲中」处理（不算失败），避免误杀正在慢起的投屏。
const PLAY_VERIFY_POLLS: u32 = 12;

/// 起播验证结论。
#[derive(Debug, PartialEq)]
enum PlayVerdict {
    /// 电视已进入 PLAYING
    Playing,
    /// 电视仍在 TRANSITIONING（缓冲中），未报错——不算失败
    Buffering,
    /// 电视明确拒收（ERROR_OCCURRED / 长停在不播放态）
    Error(String),
}

/// 下发 Set/Play 之后的真实起播验证：轮询只读的 GetTransportInfo。
///
/// 为什么要做：以前 Set+Play 返回 200 就报「投屏成功」，但电视能否真正
/// 解码起播无人知晓——用户看到的就是黑屏转圈，而 App 界面写着成功，
/// 诊断里没有任何一环能解释。轮询传输状态把「电视起播了没」变成可判定、
/// 可降级、可诊断的事实：拒收就自动落到下一个投屏梯度。
async fn verify_playback_started(control_url: &str) -> PlayVerdict {
    verify_playback_started_with(control_url, PLAY_VERIFY_POLLS).await
}

async fn verify_playback_started_with(control_url: &str, polls: u32) -> PlayVerdict {
    let mut not_ready = 0usize;
    let mut poll_err_streak = 0u32;
    for _ in 0..polls {
        tokio::time::sleep(Duration::from_secs(1)).await;
        match dlna_get_transport_info(control_url).await {
            Ok((state, status)) => {
                poll_err_streak = 0;
                if status.eq_ignore_ascii_case("ERROR_OCCURRED") {
                    return PlayVerdict::Error(
                        "电视上报传输错误（ERROR_OCCURRED）——内容不被电视支持".to_string(),
                    );
                }
                match state.to_ascii_uppercase().as_str() {
                    "PLAYING" => return PlayVerdict::Playing,
                    "STOPPED" | "NO_MEDIA_PRESENT" => {
                        not_ready += 1;
                        // Play 已下发却连续两轮停在不播放态 = 拒收
                        // （单轮可能是切换瞬态，不急着判死）
                        if not_ready >= 2 {
                            return PlayVerdict::Error(format!(
                                "电视停留在 {}，未开始播放",
                                state
                            ));
                        }
                    }
                    _ => { /* TRANSITIONING / PAUSED_PLAYBACK 等：继续等 */ }
                }
            }
            Err(_) => {
                poll_err_streak += 1;
                if poll_err_streak >= 3 {
                    // 连续查询失败：设备多半不支持 GetTransportInfo（少数低端渲染端），
                    // 不再拖时间，按缓冲中处理（与旧版「下发即成功」行为一致）
                    return PlayVerdict::Buffering;
                }
                // 单次查询失败不断言：部分电视 HTTP 栈不稳
            }
        }
    }
    PlayVerdict::Buffering
}

async fn dlna_stop(control_url: &str) -> Result<(), String> {
    let body = "<u:Stop xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">\
<InstanceID>0</InstanceID></u:Stop>";
    dlna_soap_call(control_url, "Stop", body).await
}

async fn dlna_seek(control_url: &str, position_seconds: f64) -> Result<(), String> {
    let total = position_seconds.max(0.0) as u64;
    let target = format!("{:02}:{:02}:{:02}", total / 3600, (total % 3600) / 60, total % 60);
    let body = format!(
        "<u:Seek xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">\
<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>{}</Target></u:Seek>",
        target
    );
    dlna_soap_call(control_url, "Seek", &body).await
}

// ---------- 本地防盗链代理 ----------

/// 从 URL 里取主机 IP（control_url/location 均为 http://ip:port 形式）。
fn url_host_ip(url: &str) -> Option<IpAddr> {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let hostport = rest.split('/').next().unwrap_or(rest);
    let host = hostport.rsplit_once(':').map(|(h, _)| h).unwrap_or(hostport);
    host.trim_matches(|c| c == '[' || c == ']').parse::<IpAddr>().ok()
}

/// 计算两个 IPv4 地址相同的二进制前缀位数（纯逻辑，供单测）。
/// 惯用法是 (a ^ b).leading_zeros()：异或结果里 1 表示该位不同，
/// 前导零个数即「从最高位起连续相同的位数」；完全相同为 32。
/// 两次实测教训（都是安卓诊断报告抓出来的）：
/// ①写成 (!a) ^ b——取反只作用在 a 上，wlan0(188.223，与设备同网段)
/// 被蜂窝网卡 rmnet(10.30.x) 反超，代理地址发到移动网络；
/// ②写成 (!(a ^ b)).leading_zeros()——取反后前导零变成「不同前缀位数」，
/// 同网段 28 位被算成 0（诊断报告显示「前缀匹配 0 位」即此错），
/// 当时选对网卡纯属只剩单候选的侥幸。位运算惯用法必须带具体数值验算。
fn same_prefix_bits(a: Ipv4Addr, b: Ipv4Addr) -> u32 {
    (u32::from(a) ^ u32::from(b)).leading_zeros()
}

/// 选出与设备同一网段的本机网卡，返回（网卡 IP, 与设备 IP 的前缀匹配位数）。
/// 按匹配位数最长者胜；设备 IP 来自 SSDP 应答，是电视真实可达的网段，
/// 代理地址必须从这张网卡出。
/// 实测教训一：Windows 多网卡下默认路由探测会返回虚拟网卡 IP（如 WSL/共享
/// 网络的 82.x），电视完全不可达——表现为四路全 716 且代理连接数恒为 0，
/// 防火墙放行也无效。
/// 实测教训二：前缀位数算错（见 same_prefix_bits 注释）会让同网段网卡
/// 输给蜂窝/虚拟网卡。
fn best_local_ip_for(device: IpAddr) -> Option<(IpAddr, u32)> {
    let dev_v4 = match device {
        IpAddr::V4(v) => v,
        // 局域网 DLNA 设备几乎全是 IPv4，V6 场景回退默认路由探测
        IpAddr::V6(_) => return None,
    };
    let mut best: Option<(u32, Ipv4Addr)> = None;
    if let Ok(list) = if_addrs::get_if_addrs() {
        for iface in list {
            let ip = match iface.addr {
                if_addrs::IfAddr::V4(v4) => v4.ip,
                if_addrs::IfAddr::V6(_) => continue,
            };
            if ip.is_loopback() || ip.is_unspecified() || ip.is_link_local() {
                continue;
            }
            let bits = same_prefix_bits(dev_v4, ip);
            if best.map_or(true, |(prev, _)| bits > prev) {
                best = Some((bits, ip));
            }
        }
    }
    best.map(|(bits, ip)| (IpAddr::V4(ip), bits))
}

/// 确定本机局域网 IP（用于拼出电视可访问的代理地址）。
/// 用 UDP connect 的方式探测默认路由出口，不真正发包。
fn local_lan_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind(("0.0.0.0", 0)).ok()?;
    socket.connect("223.5.5.5:80").ok()?; // 阿里公共 DNS，仅作路由探测
    Some(socket.local_addr().ok()?.ip())
}

/// 启动本地流代理（每次投屏新建），返回 (m3u8 直取入口, TS 串流入口)。
/// - m3u8 入口：/s/<token>/<b64 目标>，分片/密钥/子列表在列表改写时指向代理；
/// - TS 入口：/s/<token>/live.ts?u=<b64 目标>，把 HLS 拼成连续 MPEG-TS，
///   服务不支持 HLS 的渲染端（三星 Tizen 实测 m3u8 一律 716）。
/// 从控制地址识别三星 Tizen 渲染端。三星 DMR 固定监听 9197 端口
/// （SSDP LOCATION 形如 http://TV:9197/dmr，AVTransport 控制地址同端口），
/// 这是可靠的设备画像信号；标准安卓/其他 DLNA 渲染端几乎不会用此端口。
fn is_samsung_renderer(control_url: &str) -> bool {
    match parse_http_url(control_url) {
        Some((_, port, _)) => port == 9197,
        None => false,
    }
}

/// preferred_ip：与设备同网段的本机网卡 IP，优先于默认路由探测。
/// samsung：设备画像（决定 TS 串流的 MIME 声明，见 Upstream.is_samsung）。
async fn start_stream_proxy(
    target: String,
    token: String,
    referer: Option<String>,
    user_agent: Option<String>,
    cookie: Option<String>,
    preferred_ip: Option<IpAddr>,
    samsung: bool,
    ad_uris: Vec<String>,
) -> Result<(String, String), String> {
    let listener = tokio::net::TcpListener::bind("0.0.0.0:0")
        .await
        .map_err(|e| format!("本地代理端口绑定失败: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("本地代理地址读取失败: {}", e))?
        .port();
    let ip = preferred_ip
        .or_else(local_lan_ip)
        .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));
    let base = format!("http://{}:{}", ip, port);
    let entry = format!(
        "{}/s/{}/{}",
        base,
        token,
        b64url_encode(target.as_bytes())
    );
    let ts_entry = format!(
        "{}/s/{}/live.ts?u={}",
        base,
        token,
        b64url_encode(target.as_bytes())
    );

    let upstream = Arc::new(Upstream {
        referer,
        user_agent,
        cookie,
        token: token.clone(),
        is_samsung: samsung,
        ad_uris,
    });
    tauri::async_runtime::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _peer)) => {
                    let upstream = upstream.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = handle_proxy_conn(stream, upstream).await {
                            record_proxy_error(e);
                        }
                    });
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            }
        }
    });

    if let Ok(mut guard) = PROXY.lock() {
        *guard = Some(ProxyState { base: base.clone(), token });
    }
    let _ = PROXY_SEQ.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut guard) = PROXY_LAST_ERROR.lock() {
        guard.clear();
    }
    Ok((entry, ts_entry))
}

fn stop_stream_proxy() {
    // 状态置空即可：下一次投屏会建新的 listener；
    // 旧 listener 任务没有句柄可 abort，随连接自然结束后结束（accept 循环会一直挂着，
    // 但每次投屏只占一个任务，量级可忽略）。置空保证 proxy_url_for 取到新 base。
    if let Ok(mut guard) = PROXY.lock() {
        *guard = None;
    }
}

// ---------- 本地视频文件服务（本地视频投屏用） ----------
// 把本机视频文件通过 HTTP 暴露给局域网电视取流。URL 形如
// http://<lan-ip>:<port>/l/<token>/<filename>，保留原始文件名以暴露扩展名，
// 使投屏端的 protocol_info_for 能按扩展名正确声明 MIME。支持 Range（电视拖拽进度）。
// 三星等渲染端在 SetAVTransportURI 前会做 HEAD 可达性 + contentFeatures 合规探测，
// 因此 HEAD/GET 都补上 DLNA 头，避免被判 716。

#[derive(Serialize)]
pub struct LocalFileEntry {
    /// 投屏用 LAN URL（与设备同网段，电视可达）
    pub url: String,
    /// 本机播放用回环地址（127.0.0.1，无需经局域网）
    pub loopback_url: String,
    pub token: String,
}

// 本地文件引用：磁盘路径（桌面/部分 Android），或 Android SAF content:// URI
#[derive(Clone)]
enum LocalFileRef {
    Disk(PathBuf),
    // Android 文档选择器返回 content://，需经 tauri-plugin-fs 的 content resolver 取 fd 读取
    Content(String),
}

struct LocalFileState {
    base: String,
    files: HashMap<String, LocalFileRef>,
    port: u16,
}

static LOCAL_FILE: Lazy<Mutex<Option<LocalFileState>>> = Lazy::new(|| Mutex::new(None));

/// 按文件名/扩展名给 MIME（投屏端校验 protocolInfo 用）。
fn local_file_mime_from_name(name: &str) -> &'static str {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase());
    match ext.as_deref() {
        Some("mp4") | Some("m4v") | Some("mov") => "video/mp4",
        Some("mkv") => "video/x-matroska",
        Some("webm") => "video/webm",
        Some("flv") => "video/x-flv",
        Some("ts") | Some("m2ts") => "video/mp2t",
        Some("m3u8") => "application/vnd.apple.mpegurl",
        Some("mp3") => "audio/mpeg",
        Some("aac") => "audio/aac",
        Some("m4a") => "audio/mp4",
        _ => "application/octet-stream",
    }
}

fn local_file_mime(path: &Path) -> &'static str {
    local_file_mime_from_name(path.file_name().and_then(|f| f.to_str()).unwrap_or(""))
}

/// 从 content:// URI 中抽取一个带扩展名的文件名，用于 URL 暴露扩展名与 MIME 兜底。
/// content URI 末段通常不含真实文件名，尽力提取；提取不到则默认 video.mp4（最兼容）。
fn extract_fname_from_content_uri(uri: &str) -> String {
    let decoded = uri.replace("%3A", ":").replace("%2F", "/");
    if let Some(pos) = decoded.rfind('/') {
        let last = &decoded[pos + 1..];
        if last.contains('.') && last.len() > 3 {
            return last.to_string();
        }
    }
    // 退回：找 .ext 模式
    if let Some(m) = uri.rfind('.') {
        let ext = &uri[m + 1..];
        if !ext.is_empty()
            && ext.len() <= 4
            && ext.len() >= 2
            && ext.chars().all(|c| c.is_ascii_alphanumeric())
        {
            return format!("video.{}", ext);
        }
    }
    "video.mp4".to_string()
}

#[tauri::command]
pub async fn start_local_file_server(
    app: tauri::AppHandle,
    path: String,
    preferred_ip: Option<IpAddr>,
) -> Result<LocalFileEntry, String> {
    // Android 文档选择器返回 content:// URI，桌面返回 file:// 或普通路径。
    let is_content = path.starts_with("content://");
    let (ref_entry, fname) = if is_content {
        (
            LocalFileRef::Content(path.clone()),
            extract_fname_from_content_uri(&path),
        )
    } else {
        let p = PathBuf::from(&path);
        if !p.is_file() {
            return Err(format!("文件不存在或不是普通文件: {}", path));
        }
        let fname = p
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or("video.mp4")
            .to_string();
        (LocalFileRef::Disk(p), fname)
    };
    ensure_local_file_server(app.clone(), preferred_ip).await?;
    let token = generate_session_token();
    let (url, loopback_url) = {
        let mut guard = LOCAL_FILE.lock().unwrap();
        match guard.as_mut() {
            Some(state) => {
                state.files.insert(token.clone(), ref_entry);
                (
                    format!("{}/l/{}/{}", state.base, token, fname),
                    format!("http://127.0.0.1:{}/l/{}/{}", state.port, token, fname),
                )
            }
            None => return Err("本地文件服务未启动".into()),
        }
    };
    Ok(LocalFileEntry {
        url,
        loopback_url,
        token,
    })
}

#[tauri::command]
pub fn stop_local_file_server() {
    if let Ok(mut guard) = LOCAL_FILE.lock() {
        *guard = None; // 清空后下次投屏重新建 listener
    }
}

/// 调起系统文件选择器，返回用户选中的本地视频文件真实路径（前端据此起本地文件服务投屏）。
/// 用官方 dialog 插件，Android/桌面通用。
#[tauri::command]
pub async fn pick_local_video(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter(
                "视频/音频文件",
                &["mp4", "mkv", "m3u8", "ts", "m2ts", "webm", "mov", "flv", "mp3", "m4a"],
            )
            .blocking_pick_file()
    })
    .await
    .map_err(|e| format!("文件选择任务失败: {}", e))?;
    // 返回原始标识：桌面 Path 或 Url(file://) 转真实路径；Android Url(content://) 原样保留，
    // 交给 start_local_file_server 按 content:// 走 fs 插件 content resolver 读取。
    Ok(path.map(|p| match p {
        FilePath::Path(pb) => pb.to_string_lossy().to_string(),
        FilePath::Url(u) => u
            .to_file_path()
            .map(|pb| pb.to_string_lossy().to_string())
            .unwrap_or_else(|_| u.to_string()),
    }))
}

// ---------- 可配置 VIP 解析 ----------
// 把爱奇艺/腾讯/优酷等页面 URL 交给用户可配置的第三方解析站，取回真实可播 m3u8/mp4。
// 解析站地址不硬编码，由前端设置传入（默认示例 jx.xmflv.com）。
// 提取策略：①最终响应本身就是媒体（直接返回）；②从 HTML/JS 中扫出媒体链接；
// ③解析站返回 JSON 的 url 字段。多策略兜底第三方站改版。

#[derive(Serialize)]
pub struct ResolveResult {
    pub url: String,
    pub title: Option<String>,
}

#[tauri::command]
pub async fn resolve_vip_url(page_url: String, api_base: String) -> Result<ResolveResult, String> {
    let api_base = api_base.trim();
    if api_base.is_empty() {
        return Err("解析站地址为空，请在设置中配置解析接口".into());
    }
    // 组装解析请求地址：<api_base> 可能带或不带 http(s):// 与结尾斜杠
    let base = if api_base.contains("://") {
        api_base.to_string()
    } else {
        format!("https://{}", api_base)
    };
    let api_url = if base.ends_with('/') {
        format!("{}?url={}", base, urlencode(&page_url))
    } else {
        format!("{}/?url={}", base, urlencode(&page_url))
    };

    let resp = HTTP
        .get(&api_url)
        .header(
            reqwest::header::USER_AGENT,
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        )
        .header(reqwest::header::REFERER, base.as_str())
        .send()
        .await
        .map_err(|e| format!("解析请求失败（网络/解析站不可达）: {}", e))?;
    let status = resp.status();
    let final_url = resp.url().to_string();
    let ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = resp
        .text()
        .await
        .map_err(|e| format!("解析响应读取失败: {}", e))?;

    // ① 最终响应本身就是媒体（重定向到直链，或 content-type 是视频/播放列表）
    if is_media_url(&final_url)
        || ct.starts_with("video/")
        || ct.contains("mpegurl")
        || ct.contains("application/vnd.apple")
    {
        return Ok(ResolveResult {
            url: final_url,
            title: extract_title(&body),
        });
    }
    // ② 从 HTML/JS 中扫出第一个媒体链接
    if let Some(found) = extract_media_url(&body, &base) {
        return Ok(ResolveResult {
            url: found,
            title: extract_title(&body),
        });
    }
    // ③ 解析站返回 JSON（常见于 {url:"...",title:"..."}）
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
        if let Some(u) = json.get("url").and_then(|v| v.as_str()) {
            if is_media_url(u) {
                return Ok(ResolveResult {
                    url: u.to_string(),
                    title: json
                        .get("title")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                });
            }
        }
    }
    Err(format!(
        "未能从解析站响应中提取可播地址（状态码 {}）。解析站可能改版/失效，请在设置中更换解析接口。",
        status
    ))
}

/// 仅编码 URL 中的保留字符（保持可读性，解析站普遍接受）
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

fn is_media_url(u: &str) -> bool {
    let lower = u.to_ascii_lowercase();
    lower.contains(".m3u8")
        || lower.contains(".mp4")
        || lower.contains(".mkv")
        || lower.contains(".ts")
        || lower.contains(".webm")
        || lower.contains(".flv")
}

/// 在 HTML/JS 文本中找出第一个媒体直链；优先排除解析站自身域名，优先 https。
fn extract_media_url(html: &str, self_base: &str) -> Option<String> {
    let self_host = self_base
        .split("://")
        .nth(1)
        .and_then(|r| r.split('/').next())
        .unwrap_or("");
    let mut candidates: Vec<(bool, String)> = Vec::new();
    let bytes = html.as_bytes();
    let mut i = 0;
    while i < bytes.len().saturating_sub(4) {
        if (bytes[i] == b'h' && bytes[i + 1] == b't' && bytes[i + 2] == b't' && bytes[i + 3] == b'p')
            || (bytes[i] == b'H' && bytes[i + 1] == b'T' && bytes[i + 2] == b'T' && bytes[i + 3] == b'P')
        {
            // 扩展 token 到引号/空白/结束
            let mut j = i;
            while j < bytes.len() {
                let c = bytes[j];
                if c == b'"' || c == b'\'' || c == b' ' || c == b'<' || c == b'\\' || c == b')' {
                    break;
                }
                j += 1;
            }
            let tok = String::from_utf8_lossy(&bytes[i..j]).to_string();
            let lower = tok.to_ascii_lowercase();
            if is_media_url(&lower) {
                let is_self = !self_host.is_empty() && lower.contains(&self_host.to_ascii_lowercase());
                candidates.push((is_self, tok));
            }
            i = j.max(i + 4);
        } else {
            i += 1;
        }
    }
    // 优先返回非解析站自身域名的链接；都没有再退而求其次
    candidates
        .iter()
        .find(|(is_self, _)| !is_self)
        .or_else(|| candidates.first())
        .map(|(_, u)| u.clone())
}

fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title>")? + 7;
    let end = lower[start..].find("</title>")?;
    let t = html[start..start + end].trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

// ---------- AirPlay 发端（投 Apple TV / 支持 AirPlay 的电视） ----------
// 参考 MiracastReceiver 的 AirPlay 接收端实现：URL 投屏只需 mDNS 发现（_airplay._tcp）
// + 一个 POST /play（Content-Location 带视频 URL、Start-Position 从头播），无需 RTSP 镜像加密。
// 三星/安卓 DLNA 走 cast_to_device；Apple TV 等走 cast_to_airplay。

static MDNS: Lazy<Mutex<Option<ServiceDaemon>>> = Lazy::new(|| Mutex::new(None));

/// 搜索局域网内的 AirPlay 接收端。返回的设备 control_url 即 http://<ip>:<port>，protocol=airplay。
#[tauri::command]
pub async fn search_airplay_devices(timeout_ms: Option<u64>) -> Result<Vec<DlnaDevice>, String> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(3000).clamp(500, 8000));
    // 取/建 mDNS 守护进程（绑定 5353，单例复用，避免重复占用多播端口）
    let daemon = {
        let mut g = MDNS.lock().unwrap();
        if g.is_none() {
            match ServiceDaemon::new() {
                Ok(d) => *g = Some(d),
                Err(e) => {
                    return Err(format!(
                        "AirPlay 发现初始化失败（mDNS 多播权限？）: {}",
                        e
                    ))
                }
            }
        }
        g.as_ref().unwrap().clone()
    };
    // browse() 直接返回 flume 接收端（无 get_event_receiver 一说）。flume 的
    // RecvTimeoutError 变体无法在代码里直接命名，故在阻塞任务里按 deadline 轮询：
    // 短超时 recv_timeout 无论「超时」还是「通道断开」都继续轮询，直到 deadline 才收尾。
    let receiver = daemon
        .browse("_airplay._tcp.local.")
        .map_err(|e| format!("AirPlay 浏览失败: {}", e))?;
    let devices = tauri::async_runtime::spawn_blocking(move || {
        let mut map: HashMap<String, DlnaDevice> = HashMap::new();
        let deadline = Instant::now() + timeout;
        loop {
            // 按 deadline 轮询：短超时 recv_timeout 无论「超时」还是「通道断开」
            // 都继续轮询，直到到达 deadline 才收尾（flume 的 RecvTimeoutError 无法
            // 在代码里直接命名其变体，故用 deadline 统一兜底，避免依赖 flume 类型）。
            if Instant::now() >= deadline {
                break;
            }
            match receiver.recv_timeout(Duration::from_millis(250)) {
                Ok(ServiceEvent::ServiceResolved(info)) => {
                    // get_addresses() 返回 IPv4 集合，元素即 Ipv4Addr，无需再 is_ipv4
                    let fullname = info.get_fullname();
                    let name = fullname.split('.').next().unwrap_or(fullname).to_string();
                    let addr = info.get_addresses().iter().next().copied();
                    let port = info.get_port();
                    if let Some(a) = addr {
                        if port > 0 {
                            // Ipv4Addr 直接 Display，不需要 .ip()
                            let base = format!("http://{}:{}", a, port);
                            let key = format!("{}:{}", a, port);
                            map.insert(
                                key,
                                DlnaDevice {
                                    name,
                                    control_url: base.clone(),
                                    location: base,
                                    protocol: "airplay".to_string(),
                                },
                            );
                        }
                    }
                }
                // 其它事件（服务移除/更新）或任意 recv 错误：继续轮询直到 deadline
                _ => continue,
            }
        }
        map
    })
    .await
    .map_err(|e| format!("AirPlay 设备收集任务失败: {}", e))?;
    Ok(devices.into_values().collect())
}

/// AirPlay 视频投屏：POST /play，Content-Location 带视频 URL，Start-Position 从头播放。
#[tauri::command]
pub async fn cast_to_airplay(base_url: String, video_url: String) -> Result<(), String> {
    let url = format!("{}/play", base_url.trim_end_matches('/'));
    // text/parameters：每行 Key: Value，CRLF 结尾
    let body = format!("Content-Location: {}\r\nStart-Position: 0.000000\r\n\r\n", video_url);
    let resp = HTTP
        .post(&url)
        .header(reqwest::header::CONTENT_TYPE, "text/parameters")
        .header("User-Agent", "LibreTV/1.0")
        .header("X-Apple-Client-Name", "LibreTV")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("AirPlay /play 请求失败（设备不可达？）: {}", e))?;
    let status = resp.status();
    if status.is_success() || status.as_u16() == 200 {
        Ok(())
    } else {
        Err(format!(
            "AirPlay 投屏被拒绝（状态码 {}）。Apple TV 需在电视上允许本机 AirPlay 连接。",
            status
        ))
    }
}

async fn ensure_local_file_server(
    app: tauri::AppHandle,
    preferred_ip: Option<IpAddr>,
) -> Result<(), String> {
    if LOCAL_FILE.lock().unwrap().is_some() {
        return Ok(());
    }
    let listener = tokio::net::TcpListener::bind("0.0.0.0:0")
        .await
        .map_err(|e| format!("本地文件服务端口绑定失败: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("本地文件地址读取失败: {}", e))?
        .port();
    // 优先用与设备同网段的本机网卡 IP，保证电视可达（多网卡/VPN 下尤其关键）
    let ip = match preferred_ip {
        Some(dev) => best_local_ip_for(dev)
            .map(|(ip, _)| ip)
            .or(Some(dev))
            .or_else(local_lan_ip)
            .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST)),
        None => local_lan_ip().unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST)),
    };
    let base = format!("http://{}:{}", ip, port);
    {
        let mut guard = LOCAL_FILE.lock().unwrap();
        *guard = Some(LocalFileState {
            base: base.clone(),
            files: HashMap::new(),
            port,
        });
    }
    tauri::async_runtime::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = handle_local_file_conn(stream, app).await;
                    });
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            }
        }
    });
    Ok(())
}

async fn handle_local_file_conn(
    mut stream: tokio::net::TcpStream,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // 读请求头（最多 16KB），与代理连接同范式
    let mut buffer = vec![0u8; 16384];
    let mut received = 0usize;
    loop {
        if received >= buffer.len() {
            return Err("请求头过大".to_string());
        }
        let n = stream
            .read(&mut buffer[received..])
            .await
            .map_err(|e| format!("读取请求失败: {}", e))?;
        if n == 0 {
            break;
        }
        received += n;
        if buffer[..received].windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    let head = String::from_utf8_lossy(&buffer[..received]).to_string();
    let request_line = head.lines().next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let req_path = parts.next().unwrap_or_default().to_string();
    let path_only = req_path.split('?').next().unwrap_or("").to_string();
    let segs: Vec<&str> = path_only.split('/').filter(|s| !s.is_empty()).collect();

    // 非 /l 路径：健康检查
    if segs.first().copied() != Some("l") || segs.len() < 2 {
        let body = b"LibreTV local file server";
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.write_all(body).await;
        let _ = stream.flush().await;
        return Ok(());
    }
    let token = segs[1];
    let entry: Option<LocalFileRef> = {
        let guard = LOCAL_FILE.lock().unwrap();
        guard.as_ref().and_then(|s| s.files.get(token)).cloned()
    };
    let entry = match entry {
        Some(e) => e,
        None => {
            write_status(&mut stream, "404 Not Found", b"not found").await;
            return Ok(());
        }
    };
    // 打开文件：桌面/部分 Android 走磁盘 Path；Android SAF 走 content://（fs 插件取 fd）
    let (mut file, total, mime) = match entry {
        LocalFileRef::Disk(p) => {
            let meta = match tokio::fs::metadata(&p).await {
                Ok(m) => m,
                Err(_) => {
                    write_status(&mut stream, "404 Not Found", b"not found").await;
                    return Ok(());
                }
            };
            if meta.is_dir() {
                write_status(&mut stream, "404 Not Found", b"not found").await;
                return Ok(());
            }
            let total = meta.len();
            let mime = local_file_mime(&p);
            let f = match tokio::fs::File::open(&p).await {
                Ok(f) => f,
                Err(_) => {
                    write_status(&mut stream, "404 Not Found", b"not found").await;
                    return Ok(());
                }
            };
            (f, total, mime)
        }
        LocalFileRef::Content(uri) => {
            let fname = extract_fname_from_content_uri(&uri);
            let mime = local_file_mime_from_name(&fname);
            // content:// 经 fs 插件 content resolver 取文件描述符，包装成可 seek 的异步文件
            let fp: FilePath = uri.parse().unwrap();
            let app2 = app.clone();
            // tauri-plugin-fs 2.7+ 的 open() 按值接收 OpenOptions；
            // builder 的 setter 返回 &mut OpenOptions，需 clone 成拥有值再传入。
            let opts = OpenOptions::new().read(true).clone();
            let std_file = match tauri::async_runtime::spawn_blocking(move || {
                app2.fs().open(fp, opts)
            })
            .await
            {
                Ok(Ok(f)) => f,
                _ => {
                    write_status(
                        &mut stream,
                        "500 Internal Server Error",
                        b"open content uri failed",
                    )
                    .await;
                    return Ok(());
                }
            };
            let f = tokio::fs::File::from_std(std_file);
            let total = f.metadata().await.map(|m| m.len()).unwrap_or(0);
            (f, total, mime)
        }
    };

    // 渲染端可达性 + DLNA 合规探测：HEAD 也需要正确的 DLNA 头
    if method == "HEAD" {
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n\
transferMode.dlna.org: Streaming\r\ncontentFeatures.dlna.org: {}\r\nConnection: close\r\n\r\n",
            mime, total, SAMSUNG_DLNA_FLAGS
        );
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.flush().await;
        return Ok(());
    }
    if method != "GET" {
        let response = "HTTP/1.1 405 Method Not Allowed\r\nAllow: GET, HEAD\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.flush().await;
        return Ok(());
    }

    // Range 解析：单一 bytes 区间（电视拖拽进度足够）
    let range = head
        .lines()
        .find(|line| line.to_ascii_lowercase().starts_with("range:"))
        .and_then(|line| line.split_once(':'))
        .map(|(_, v)| v.trim().to_string());
    let (start, end, status_line, content_range) = match range {
        Some(r) if r.to_ascii_lowercase().starts_with("bytes=") => {
            let spec = &r[6..];
            let (s, e) = match spec.split_once('-') {
                Some((s, e)) => (s.trim(), e.trim()),
                None => ("0", ""),
            };
            let start = s.parse::<u64>().unwrap_or(0);
            let end = if e.is_empty() {
                total.saturating_sub(1)
            } else {
                e.parse::<u64>()
                    .unwrap_or(total.saturating_sub(1))
                    .min(total.saturating_sub(1))
            };
            if start > end || start >= total {
                write_status(&mut stream, "416 Range Not Satisfiable", b"out of range").await;
                return Ok(());
            }
            (
                start,
                end,
                "206 Partial Content",
                format!("bytes {}-{}/{}", start, end, total),
            )
        }
        _ => (0, total.saturating_sub(1), "200 OK", String::new()),
    };
    let len = end - start + 1;
    if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        write_status(&mut stream, "500 Internal Server Error", b"seek failed").await;
        return Ok(());
    }
    let header = if status_line.starts_with("206") {
        format!(
            "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nContent-Range: {}\r\nAccept-Ranges: bytes\r\n\
transferMode.dlna.org: Streaming\r\ncontentFeatures.dlna.org: {}\r\nConnection: close\r\n\r\n",
            status_line, mime, len, content_range, SAMSUNG_DLNA_FLAGS
        )
    } else {
        format!(
            "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n\
transferMode.dlna.org: Streaming\r\ncontentFeatures.dlna.org: {}\r\nConnection: close\r\n\r\n",
            status_line, mime, len, SAMSUNG_DLNA_FLAGS
        )
    };
    if stream.write_all(header.as_bytes()).await.is_err() {
        return Ok(());
    }
    // 分块转发 body，避免大文件一次性读入内存
    let mut remaining = len;
    let mut buf = vec![0u8; 65536];
    while remaining > 0 {
        let to_read = remaining.min(buf.len() as u64) as usize;
        match file.read(&mut buf[..to_read]).await {
            Ok(0) => break,
            Ok(n) => {
                if stream.write_all(&buf[..n]).await.is_err() {
                    break;
                }
                remaining -= n as u64;
            }
            Err(_) => break,
        }
    }
    let _ = stream.flush().await;
    Ok(())
}

async fn write_status(stream: &mut tokio::net::TcpStream, status: &str, body: &[u8]) {
    let response = format!(
        "HTTP/1.1 {}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        status,
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.write_all(body).await;
    let _ = stream.flush().await;
}

async fn handle_proxy_conn(mut stream: tokio::net::TcpStream, upstream: Arc<Upstream>) -> Result<(), String> {
    // 读请求头（最多 16KB）
    let mut buffer = vec![0u8; 16384];
    let mut received = 0usize;
    loop {
        if received >= buffer.len() {
            return Err("请求头过大".to_string());
        }
        let n = stream
            .read(&mut buffer[received..])
            .await
            .map_err(|e| format!("读取请求失败: {}", e))?;
        if n == 0 {
            break;
        }
        received += n;
        if buffer[..received].windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    let head = String::from_utf8_lossy(&buffer[..received]).to_string();
    let request_line = head.lines().next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    // 任何到达代理的请求（含 HEAD 探测）都说明「电视/客户端能连上本机」——计数用于失败诊断。
    // 计数必须在方法过滤之前：渲染端（三星等）常在 SetAVTransportURI 时用 HEAD
    // 探测资源可达性，此前 HEAD 直接断连且不计数，表现为 716 + 诊断连接数恒 0。
    PROXY_CONN_COUNT.fetch_add(1, Ordering::Relaxed);

    if method != "GET" && method != "HEAD" {
        // 其他方法也回标准响应而不是直接断连——渲染端探测被掐会被判为资源不存在（716）
        let response =
            "HTTP/1.1 405 Method Not Allowed\r\nAllow: GET, HEAD\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.flush().await;
        return Ok(());
    }
    // 透传 Range（电视拖进度条时发出；HEAD 用不到，解析无害）
    let range = head
        .lines()
        .find(|line| line.to_ascii_lowercase().starts_with("range:"))
        .and_then(|line| line.split_once(':'))
        .map(|(_, value)| value.trim().to_string());

    // 路径形如 /s/<token>/<b64url(目标地址)>，健康检查路径直接放行。
    if !path.contains("/s/") {
        let body = b"LibreTV DLNA proxy";
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.write_all(body).await;
        let _ = stream.flush().await;
        return Ok(());
    }

    // 校验会话令牌：不匹配一律 403（防止局域网其他主机把本机当公开跳板）
    let after_s = path.split("/s/").nth(1).unwrap_or_default();
    let (req_token, encoded) = match after_s.split_once('/') {
        Some((t, e)) => (t, e),
        None => ("", after_s),
    };
    if req_token.is_empty() || req_token != upstream.token {
        let body = b"forbidden";
        let response = format!(
            "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.write_all(body).await;
        let _ = stream.flush().await;
        return Ok(());
    }
    // live.ts 是会话级 TS 串流端点（?u=<b64 目标>），不是 b64 编码的直取地址
    let (encoded, query) = match encoded.split_once('?') {
        Some((e, q)) => (e, Some(q)),
        None => (encoded, None),
    };
    if method == "HEAD" {
        // 渲染端（三星等）在 SetAVTransportURI 前用 HEAD 探测资源可达性与 DLNA 合规：
        // 不仅看状态码，还要看 contentFeatures.dlna.org / transferMode.dlna.org 头，
        // 缺了就会被判 716 Resource not found（此前只回 200+Content-Type 仍 716 的根因）。
        let ctype = if encoded == "live.ts" {
            // 三星要求 DLNA 专用 MIME video/vnd.dlna.mpeg-tts；标准安卓 DLNA 渲染端
            // 更认 video/mp2t。两者 DIDL 的 DLNA flags 与下方响应头一致，仅 MIME 分流。
            if upstream.is_samsung {
                "video/vnd.dlna.mpeg-tts"
            } else {
                "video/mp2t"
            }
        } else {
            match b64url_decode(encoded)
                .and_then(|b| String::from_utf8(b).ok())
            {
                Some(target) => protocol_info_for(&target, upstream.is_samsung),
                None => "application/octet-stream",
            }
        };
        // live.ts 支持 Range 续传：带 Range 且会话状态覆盖时回 206+Content-Range，
        // 让渲染端在正式取流前就知道可以从断点继续（此前 Accept-Ranges: none 会
        // 引导三星这类渐进式取流端放弃续传，改用整段重拉）。
        let (head_status, head_content_range) = if encoded == "live.ts" {
            let requested = parse_range_start(&range).filter(|n| *n > 0);
            let covered = requested
                .map(|n| {
                    TS_STREAM_STATES
                        .lock()
                        .ok()
                        .and_then(|m| m.get(&upstream.token).cloned())
                        .map(|st| n <= st.total_bytes && !st.served.is_empty())
                        .unwrap_or(false)
                })
                .unwrap_or(false);
            if covered {
                (
                    "206 Partial Content",
                    format!("Content-Range: bytes {}-/*\r\n", requested.unwrap_or(0)),
                )
            } else {
                ("200 OK", String::new())
            }
        } else {
            ("200 OK", String::new())
        };
        let accept_ranges = if encoded == "live.ts" { "bytes" } else { "none" };
        let response = format!(
            "HTTP/1.1 {}\r\nContent-Type: {}\r\n{}Accept-Ranges: {}\r\n\
transferMode.dlna.org: Streaming\r\ncontentFeatures.dlna.org: {}\r\nConnection: close\r\n\r\n",
            head_status, ctype, head_content_range, accept_ranges, SAMSUNG_DLNA_FLAGS
        );
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.flush().await;
        return Ok(());
    }
    if encoded == "live.ts" {
        let u = query
            .and_then(|q| {
                q.split('&')
                    .find(|kv| kv.starts_with("u="))
                    .and_then(|kv| kv.get(2..))
            })
            .unwrap_or_default();
        let ts_target_bytes = b64url_decode(u).ok_or("TS 串流地址解码失败")?;
        let ts_target = String::from_utf8(ts_target_bytes).map_err(|_| "TS 串流地址不是合法 UTF-8")?;
        return serve_live_ts(stream, upstream.token.clone(), ts_target, upstream, range.clone()).await;
    }
    if encoded.is_empty() {
        return Err("代理路径缺少目标地址".to_string());
    }
    let target_bytes = b64url_decode(encoded).ok_or("代理地址解码失败")?;
    let target = String::from_utf8(target_bytes).map_err(|_| "代理地址不是合法 UTF-8")?;

    // 构造上游请求：带鉴权头 + Range 透传；未提供 UA 时补默认浏览器 UA
    let mut request = HTTP.get(mirror_url(&target));
    if let Some(referer) = &upstream.referer {
        request = request.header(reqwest::header::REFERER, referer);
    }
    request = request.header(
        reqwest::header::USER_AGENT,
        upstream.user_agent.as_deref().unwrap_or(DEFAULT_UPSTREAM_UA),
    );
    if let Some(cookie) = &upstream.cookie {
        request = request.header(reqwest::header::COOKIE, cookie);
    }
    // 清单请求不透传 Range：部分源站对带 Range 的清单请求回 206 + 截断内容，
    // 代理据此改写出来的就是半份清单——电视只会表现为黑屏或播到一半断掉。
    // 清单本身只有几十 KB，整份读取没有任何性能顾虑。
    let target_is_playlist = {
        let lower = target.to_ascii_lowercase();
        let clean = lower
            .split(|c: char| c == '?' || c == '#')
            .next()
            .unwrap_or(&lower);
        clean.ends_with(".m3u8") || clean.ends_with(".m3u")
    };
    if let Some(range) = &range {
        if !target_is_playlist {
            request = request.header(reqwest::header::RANGE, range);
        }
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("拉取上游流失败: {}", e))?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let content_length = response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    let content_range = response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());
    let accept_ranges = response
        .headers()
        .get(reqwest::header::ACCEPT_RANGES)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.to_string());

    let is_playlist = content_type.contains("mpegurl")
        || content_type.contains("m3u8")
        || target.to_ascii_lowercase().contains(".m3u8");

    if is_playlist {
        // 播放列表：整段读取（列表本身很小），把分片/密钥/子列表地址改写到本地代理
        let body_bytes = response
            .bytes()
            .await
            .map_err(|e| format!("读取播放列表失败: {}", e))?;
        let text = String::from_utf8_lossy(&body_bytes);
        let rewritten = rewrite_playlist(&text, &target, &upstream.ad_uris);
        let body = rewritten.into_bytes();
        let mut head = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.apple.mpegurl\r\nContent-Length: {}\r\nCache-Control: no-store\r\n",
            body.len()
        );
        if let Some(range_value) = &accept_ranges {
            head.push_str(&format!("Accept-Ranges: {}\r\n", range_value));
        }
        head.push_str("Connection: close\r\n\r\n");
        stream
            .write_all(head.as_bytes())
            .await
            .map_err(|e| format!("写出响应头失败: {}", e))?;
        stream
            .write_all(&body)
            .await
            .map_err(|e| format!("写出播放列表失败: {}", e))?;
        stream.flush().await.map_err(|e| format!("刷新失败: {}", e))?;
        return Ok(());
    }

    // 媒体分片/密钥：状态码与长度头原样透传，流式转发
    let mut head = format!(
        "HTTP/1.1 {} {}\r\n",
        status.as_u16(),
        status.canonical_reason().unwrap_or("")
    );
    if !content_type.is_empty() {
        head.push_str(&format!("Content-Type: {}\r\n", content_type));
    }
    if let Some(length) = content_length {
        head.push_str(&format!("Content-Length: {}\r\n", length));
    }
    if let Some(range_value) = &content_range {
        head.push_str(&format!("Content-Range: {}\r\n", range_value));
    }
    if let Some(range_value) = &accept_ranges {
        head.push_str(&format!("Accept-Ranges: {}\r\n", range_value));
    }
    head.push_str("Connection: close\r\n\r\n");
    stream
        .write_all(head.as_bytes())
        .await
        .map_err(|e| format!("写出响应头失败: {}", e))?;
    let mut upstream_stream = response;
    loop {
        match upstream_stream.chunk().await {
            Ok(Some(chunk)) => {
                stream
                    .write_all(&chunk)
                    .await
                    .map_err(|e| format!("转发数据失败: {}", e))?;
            }
            Ok(None) => break,
            Err(e) => return Err(format!("上游读取失败: {}", e)),
        }
    }
    stream.flush().await.map_err(|e| format!("刷新失败: {}", e))?;
    Ok(())
}

// ---------- TS 串流（HLS → 连续 MPEG-TS） ----------
// 背景：三星 Tizen 官方支持容器（AVI/MKV/ASF/MP4/3GPP/PS/TS）不含 HLS，
// 实测 SetAVTransportURI 下发 m3u8 一律 716 Resource not found，代理/直连/
// 改协议声明都一样。做法：代理在本地顺序拉取分片，原样拼接成无限 TS 字节流
// 喂给电视——TS 分片自带 PAT/PMT，拼接即可播。防盗链头（Referer/UA/Cookie）
// 由本机补齐，电视拿到的只是一个普通 TS 直播地址。

/// 带会话鉴权头的上游 GET（TS 串流专用；直取通道的 Range 透传逻辑不同，不复用）。
/// 同步构建 RequestBuilder（非 async——构建器不涉及 IO）。
fn upstream_get(url: &str, upstream: &Upstream) -> reqwest::RequestBuilder {
    let mut request = HTTP.get(mirror_url(url));
    if let Some(referer) = &upstream.referer {
        request = request.header(reqwest::header::REFERER, referer);
    }
    request = request.header(
        reqwest::header::USER_AGENT,
        upstream.user_agent.as_deref().unwrap_or(DEFAULT_UPSTREAM_UA),
    );
    if let Some(cookie) = &upstream.cookie {
        request = request.header(reqwest::header::COOKIE, cookie);
    }
    request
}

/// 拉取文本资源（清单），非 2xx 报错。
async fn upstream_text(url: &str, upstream: &Upstream) -> Result<String, String> {
    let response = upstream_get(url, upstream)
        .send()
        .await
        .map_err(|e| format!("请求清单失败: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("清单请求失败: HTTP {}", response.status().as_u16()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取清单失败: {}", e))?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

/// master 清单变体选择（纯逻辑，供单测）：取第一个 STREAM-INF 的变体 URI（绝对地址）。
fn pick_variant(text: &str, base_url: &str) -> Option<String> {
    let mut lines = text.lines();
    while let Some(line) = lines.next() {
        if line.trim_start().starts_with("#EXT-X-STREAM-INF") {
            for candidate in lines.by_ref() {
                let c = candidate.trim();
                if c.is_empty() || c.starts_with('#') {
                    continue;
                }
                return Some(resolve_url(base_url, c));
            }
            return None;
        }
    }
    None
}

/// 清单分类（纯逻辑，供单测）：resolve_media_playlist 按结果决定继续跟变体
/// 还是到达媒体清单。媒体清单解析错误（加密/fMP4）原样透传。
enum PlaylistKind {
    /// 媒体清单（分片列表本身由 fetch_media_playlist 另行获取，此处只做分类与合法性校验）
    Media,
    /// master 清单：第一个变体的绝对地址
    Master(String),
    Unknown,
}

fn classify_playlist(text: &str, base_url: &str) -> Result<PlaylistKind, String> {
    // 媒体清单特征：分片时长标记或目标时长声明
    if text.contains("#EXTINF") || text.contains("#EXT-X-TARGETDURATION") {
        // 解析一次只为校验（加密/fMP4 直接报错并透传），分片列表不由此处产出。
        // 广告剔除不在这一步做（这里只判断清单类型），实际过滤在取流时按 ad_uris 执行。
        return parse_media_playlist(text, base_url, &[]).map(|_| PlaylistKind::Media);
    }
    if text.contains("#EXT-X-STREAM-INF") {
        return Ok(match pick_variant(text, base_url) {
            Some(v) => PlaylistKind::Master(v),
            None => PlaylistKind::Unknown,
        });
    }
    Ok(PlaylistKind::Unknown)
}

/// 跟随 master 清单找到媒体清单（最多 3 层嵌套）。
async fn resolve_media_playlist(url: &str, upstream: &Upstream) -> Result<String, String> {
    let mut current = url.to_string();
    for _ in 0..3 {
        let text = upstream_text(&current, upstream).await?;
        match classify_playlist(&text, &current)? {
            PlaylistKind::Media => return Ok(current),
            PlaylistKind::Master(variant) => current = variant,
            PlaylistKind::Unknown => {
                return Err(if text.contains("#EXT-X-STREAM-INF") {
                    "master 清单里没有可用的变体".to_string()
                } else {
                    "地址不是 HLS 播放清单".to_string()
                });
            }
        }
    }
    Err("清单嵌套层级过深".to_string())
}

/// 解析媒体清单（纯逻辑，供单测）：返回（分片绝对地址列表, 是否 VOD/有 ENDLIST）。
/// 加密（AES-128/SAMPLE-AES）与 fMP4（EXT-X-MAP）无法靠拼接转 TS，直接报错
/// 让投屏梯度落到下一个模式。
/// ad_uris：前端判定好的广告分片 URI（已解析成绝对地址），命中的分片整块跳过。
fn parse_media_playlist(
    text: &str,
    base_url: &str,
    ad_uris: &[String],
) -> Result<(Vec<String>, bool), String> {
    let mut segments = Vec::new();
    let mut endlist = false;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("#EXT-X-KEY:") {
            let method = rest
                .split(',')
                .find_map(|kv| kv.strip_prefix("METHOD="))
                .unwrap_or("NONE");
            if !method.eq_ignore_ascii_case("NONE") {
                return Err(format!("源分片已加密（{}），TS 串流暂不支持", method));
            }
            continue;
        }
        if line.starts_with("#EXT-X-MAP") {
            return Err("源为 fMP4 封装（EXT-X-MAP），TS 串流暂不支持".to_string());
        }
        if line.starts_with("#EXT-X-ENDLIST") {
            endlist = true;
            continue;
        }
        if line.starts_with('#') {
            continue; // 其余标签不影响拼接
        }
        // 非注释非空行即分片 URI（HLS 规范），解析为绝对地址
        let resolved = resolve_url(base_url, line);
        // 广告分片：跳过。判定在前端完成，这里只执行。
        if is_ad_segment(line, &resolved, ad_uris) {
            continue;
        }
        segments.push(resolved);
    }
    Ok((segments, endlist))
}

/// 拉取并解析媒体清单。
async fn fetch_media_playlist(
    url: &str,
    upstream: &Upstream,
) -> Result<(Vec<String>, bool), String> {
    let text = upstream_text(url, upstream).await?;
    parse_media_playlist(&text, url, &upstream.ad_uris)
}

/// 上游分片请求的静默超时：这么久没收到任何数据就判定上游失联。
///
/// 没有超时的后果是整条 TS 流永久挂住：代理既不发数据也不断开，电视端缓冲
/// 耗尽后只能无限转圈，而代理这边一声不响——用户和日志都看不出发生了什么。
/// reqwest 客户端只设了 connect_timeout，建连成功后卡住是没有保护的。
const UPSTREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(20);

/// 单个分片的拉取重试次数。
///
/// 只在「拉取阶段」重试是安全的：此时还一个字节都没写进流里，重试不会产生
/// 重复数据。写阶段失败是电视断开，重试没有意义。
const SEGMENT_FETCH_RETRIES: usize = 1;

/// 连续多少个分片失败后放弃整条流。
///
/// 单片失败绝不能断流：电视一旦看到连接关闭就会重连，而重连后 `serve_live_ts`
/// 从头重新解析清单、从第一个分片重新开始 —— 于是又倒在同一片坏分片上，
/// 反复重连、反复从头拉，表现就是「投一会儿就中断」或「黑色转圈」。
/// 但连续失败说明源已不可用，硬撑只会让电视挂在一条没有数据的长连接上。
const MAX_CONSECUTIVE_SEGMENT_FAILURES: usize = 8;

/// 完整拉取一个分片到内存。
///
/// 刻意不边下边写：分片拉到一半失败时，流里已经进了半截数据，既没法重试
/// （会写入重复内容），电视拿到的也是截断的 TS 包。分片通常几百 KB，
/// 整片缓冲的代价远小于断流的代价。
async fn fetch_segment_bytes(url: &str, upstream: &Upstream) -> Result<Vec<u8>, String> {
    let response = tokio::time::timeout(
        UPSTREAM_IDLE_TIMEOUT,
        upstream_get(url, upstream).send(),
    )
    .await
    .map_err(|_| "拉取分片超时（上游无响应）".to_string())?
    .map_err(|e| format!("拉取分片失败: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("分片拉取失败: HTTP {}", response.status().as_u16()));
    }
    let mut body = response;
    let mut buf: Vec<u8> = Vec::with_capacity(256 * 1024);
    loop {
        match tokio::time::timeout(UPSTREAM_IDLE_TIMEOUT, body.chunk()).await {
            Err(_) => return Err("分片数据读取超时".to_string()),
            Ok(Ok(Some(chunk))) => buf.extend_from_slice(&chunk),
            Ok(Ok(None)) => break,
            Ok(Err(e)) => return Err(format!("读取分片数据失败: {}", e)),
        }
    }
    if buf.is_empty() {
        // 空分片直接当失败：写进流里只会让电视的解复用器多等一个包
        return Err("分片内容为空".to_string());
    }
    Ok(buf)
}

// ---------- TS 预热与预取 ----------
//
// 电视端「黑色转圈」的两大供给类成因，都在这里消除：
// 1. 首包等待：电视 GET 到达后才开始解析清单 + 拉首片，移动网络下首字节
//    可能迟至数秒，电视的起播耐心有限。预热让投屏发起（Set/Play 指令往返
//    期间）就把清单和前几个分片拉进内存，电视一连上立刻有数据。
// 2. 供给速率：旧实现逐片「拉完一片再拉下一片」，串行单连接。CDN 对单连接
//    限速/丢包抖动时供给会掉到实时以下，电视缓冲耗尽就转圈。手机浏览器里
//    hls.js 是多请求并行预取的，所以同一源 App 内能播、串行代理却转圈。
//    预取窗口（并行拉取、按序写出）把有效供给拉回多连接水平。

/// 预热分片数。前 1~2 片足以让电视起播时零等待。
const TS_PRIME_SEGMENTS: usize = 2;

/// 预取窗口深度：同时在上游挂着的分片请求数。写出仍严格按清单顺序。
// 深度 6 的依据（真机 1.5.3 诊断）：弱网单连接吞吐可低至 46 KB/s，
// 3 连 ≈ 138 KB/s 低于常见 2~3 Mbps 内容码率，电视缓冲被喝干即中止。
// 6 连 ≈ 276 KB/s 起步，与 App 内 hls.js 的并行度对齐。内存代价 ~6MB。
const TS_PREFETCH_DEPTH: usize = 6;

/// 预热缓存：分片 URL → 已拉取的字节。投屏发起时填充，serve_live_ts 消费
/// （取出即删）。下一次投屏会整体清空，不会跨会话积累。
static TS_PRIME: Lazy<Mutex<HashMap<String, Vec<u8>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn pop_prime_segment(seg: &str) -> Option<Vec<u8>> {
    TS_PRIME.lock().ok().and_then(|mut cache| cache.remove(seg))
}

fn prime_cache_size() -> usize {
    TS_PRIME.lock().map(|cache| cache.len()).unwrap_or(0)
}

/// 投屏发起时的预热：解析清单并预取前几个分片进缓存。
/// 任何失败都静默——serve_live_ts 会走正常路径重新拉取，预热只是加速。
async fn warm_ts_stream(target: String, upstream: Arc<Upstream>) {
    if let Ok(mut cache) = TS_PRIME.lock() {
        cache.clear(); // 只保留本次投屏的预热数据，防止跨投屏积累内存
    }
    let prepared = async {
        let media_url = resolve_media_playlist(&target, &upstream).await?;
        let (pending, _endlist) = fetch_media_playlist(&media_url, &upstream).await?;
        Ok::<Vec<String>, String>(pending)
    }
    .await;
    let pending = match prepared {
        Ok(list) => list,
        Err(_) => return,
    };
    for seg in pending.iter().take(TS_PRIME_SEGMENTS) {
        if let Ok(data) = fetch_segment_bytes(seg, &upstream).await {
            if let Ok(mut cache) = TS_PRIME.lock() {
                cache.insert(seg.clone(), data);
            }
        }
    }
}

/// 分片拉取（供预取任务调用）：先吃预热缓存，未命中再带上限重试地拉上游。
async fn fetch_segment_cached(seg: String, upstream: Arc<Upstream>) -> Result<Vec<u8>, String> {
    if let Some(data) = pop_prime_segment(&seg) {
        return Ok(data);
    }
    // 会话级分片数据缓存：跨重连复用已下载分片（VOD 分片不可变，URL 全局唯一）
    if let Ok(map) = TS_SEGMENT_CACHE.lock() {
        if let Some(data) = map.get(&seg) {
            return Ok(data.clone());
        }
    }
    let mut fetched = fetch_segment_bytes(&seg, &upstream).await;
    for _ in 0..SEGMENT_FETCH_RETRIES {
        if fetched.is_ok() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        fetched = fetch_segment_bytes(&seg, &upstream).await;
    }
    // 写入会话缓存：电视重连后同一分片不再重复请求 CDN
    if let Ok(data) = &fetched {
        if let Ok(mut map) = TS_SEGMENT_CACHE.lock() {
            map.insert(seg.clone(), data.clone());
            ts_seg_cache_evict(&mut map);
        }
    }
    fetched
}

/// live.ts 端点：HLS → 连续 MPEG-TS 字节流。
/// 响应头在清单探测成功之后才发——探测失败时电视拿到明确的 502，
/// 投屏梯度的报错才有意义。直播清单（无 ENDLIST）轮询追加分片直到电视断开。
///
/// 支持断点续传（Range: bytes=N-）：三星等渐进式取流的渲染端会周期性断开
/// 并带字节偏移重开连接（真机诊断：一次投屏连接 30~50 次、无代理错误、
/// 一直缓冲）。本地文件服务支持 Range 所以稳定，而旧实现无视 Range 从 0
/// 重发 → 电视字节位置错乱、PTS 大幅回跳 → 立即中止 → 再连 → 无限转圈。
/// 这里按会话（token）记录已下发分片序列与字节数，重连时精确续传。
///
/// 会话状态：分片有序表（URL, 该分片写入的字节数）+ 累计字节数。
/// 续传时在表里定位电视要的字节偏移 → 从对应分片的对应字节继续写，
/// 响应 206 + Content-Range: bytes N-/*（总长未知，HLS 拼接流无法预知）。
#[derive(Default, Clone)]
struct TsStreamState {
    served: Vec<(String, u64)>,
    total_bytes: u64,
    connections: u32,
    resume_hits: u32,
    started_at: Option<std::time::Instant>, // 会话首次连接时刻（供给速率分母）
    // ---- 跨重连缓存（VOD 清单不变，重连时无需重新请求 CDN）----
    media_url: String,           // 已解析的媒体清单地址
    segments: Vec<String>,       // 完整有序分片列表
    endlist: bool,               // VOD 标记
}

static TS_STREAM_STATES: Lazy<Mutex<HashMap<String, TsStreamState>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
const TS_STREAM_STATE_MAX: usize = 4;

/// 会话级分片数据缓存：跨重连复用已下载的分片字节。
/// 电视重连时从断点续传，锚点分片的剩余部分需要重发——
/// 如果缓存里有就不用重新请求 CDN（弱 CDN 路径上省 2~18 秒）。
/// 按 token 分键，总量上限 16MB（LRU 淘汰最旧分片）。
static TS_SEGMENT_CACHE: Lazy<Mutex<HashMap<String, Vec<u8>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
const TS_SEGMENT_CACHE_MAX_BYTES: usize = 16 * 1000 * 1000;

fn ts_seg_cache_evict(map: &mut HashMap<String, Vec<u8>>) {
    let total: usize = map.values().map(|d| d.len()).sum();
    if total <= TS_SEGMENT_CACHE_MAX_BYTES { return; }
    // 淘汰最早插入的（HashMap 无序，用 drain 逐个移除直到够小）
    let keys: Vec<String> = map.keys().cloned().collect();
    let mut removed = 0usize;
    for key in keys {
        if total - removed <= TS_SEGMENT_CACHE_MAX_BYTES { break; }
        if let Some(d) = map.remove(&key) { removed += d.len(); }
    }
}

fn ts_state_touch(token: &str) -> Option<TsStreamState> {
    let mut map = TS_STREAM_STATES.lock().ok()?;
    let state = map.entry(token.to_string()).or_default();
    state.connections += 1;
    Some(state.clone())
}

fn ts_state_evict_extra(map: &mut HashMap<String, TsStreamState>) {
    while map.len() > TS_STREAM_STATE_MAX {
        // 淘汰「连接数最小」的会话（最不活跃），避免按插入序误删当前会话
        if let Some(key) = map
            .iter()
            .min_by_key(|(_, st)| st.connections)
            .map(|(k, _)| k.clone())
        {
            map.remove(&key);
        } else {
            break;
        }
    }
}

/// 解析 Range 头里的起始字节（bytes=N- / bytes=N-M），不合法返回 None。
fn parse_range_start(range: &Option<String>) -> Option<u64> {
    let raw = range.as_deref()?.trim();
    let rest = raw
        .strip_prefix("bytes=")
        .or_else(|| raw.strip_prefix("BYTES="))?
        .trim();
    let start = rest.split('-').next()?.trim();
    if start.is_empty() {
        return None; // bytes=-M（后缀 Range）：无法映射到我们的确定性布局，忽略
    }
    // bytes=0- 视为全新下发（调用方语义：>0 才是续传），在函数内统一过滤
    start.parse::<u64>().ok().filter(|n| *n > 0)
}

/// 在已下发序列里定位电视要的字节偏移：
/// 返回 (分片下标, 片内偏移)；下标 == served.len() 表示恰好完整下发完，从其后继续。
fn locate_resume(state: &TsStreamState, n: u64) -> Option<(usize, u64)> {
    let mut acc = 0u64;
    for (idx, (_url, size)) in state.served.iter().enumerate() {
        if n < acc + *size {
            return Some((idx, n - acc));
        }
        acc += *size;
    }
    if n == acc {
        return Some((state.served.len(), 0));
    }
    None // n 超出已下发范围（理论不该发生），退回全新下发
}

async fn serve_live_ts(
    mut stream: tokio::net::TcpStream,
    token: String,
    target: String,
    upstream: Arc<Upstream>,
    range: Option<String>,
) -> Result<(), String> {
    // 探测阶段：响应头还没发出去，任何失败都要回一个明确的 5xx。
    // 以前这里是直接 `return Err`，调用方 `let _ =` 又把错误丢掉 ——
    // 结果是电视连上来后一个字节都收不到，只能无限转圈：
    // 用户看不到错因，投屏梯度也不会落到下一档。
    let prepared = async {
        // VOD 会话缓存：电视重连时不再重新请求 CDN 解析清单。
        // 每轮 resolve+fetch 是 2 次 CDN 往返，弱 CDN 路径上耗时 4~18s，
        // 重连 10 次浪费 40~180s——缓存后重连立即开始取流。
        if let Some(st) = TS_STREAM_STATES.lock().ok().and_then(|m| m.get(&token).cloned()) {
            if st.endlist && !st.media_url.is_empty() && !st.segments.is_empty() {
                return Ok((st.media_url.clone(), st.segments.clone(), st.endlist));
            }
        }
        let media_url = resolve_media_playlist(&target, &upstream).await?;
        let (pending, endlist) = fetch_media_playlist(&media_url, &upstream).await?;
        if pending.is_empty() {
            return Err("媒体清单里没有可用分片".to_string());
        }
        // 缓存到会话状态（仅 VOD：直播清单会变，不缓存）
        if endlist {
            if let Ok(mut map) = TS_STREAM_STATES.lock() {
                if let Some(st) = map.get_mut(&token) {
                    st.media_url = media_url.clone();
                    st.segments = pending.clone();
                    st.endlist = endlist;
                }
            }
        }
        Ok((media_url, pending, endlist))
    }
    .await;
    let (media_url, mut pending, mut endlist) = match prepared {
        Ok(value) => value,
        Err(e) => {
            record_proxy_error(format!("TS 串流准备失败: {}", e));
            let body = e.as_bytes();
            let head = format!(
                "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain; charset=utf-8\r\n\
Content-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(head.as_bytes()).await;
            let _ = stream.write_all(body).await;
            let _ = stream.flush().await;
            return Ok(());
        }
    };

    let ts_mime = if upstream.is_samsung {
        "video/vnd.dlna.mpeg-tts"
    } else {
        "video/mp2t"
    };

    // ---- 断点续传计划 ----
    // requested_offset：电视要的字节偏移；plan：锚点分片下标 + 片内偏移。
    // 锚点在 pending 里按 URL 对齐（防清单变化错位），对不上则退回全新下发。
    let mut resume_skip: u64 = 0;
    let mut resume_plan: Option<(usize, u64)> = None;
    let mut resume_status = "200 OK";
    let mut resume_content_range = String::new();
    let mut resume_seed_urls: Vec<String> = Vec::new();
    // 续传偏移的三个来源（优先级从高到低）：
    //   a. Range: bytes=N-（N>0）——电视明确要第 N 字节起
    //   b. 无 Range 的同会话重连——从会话已下发末尾继续。电视换连接不换位置：
    //      重置会让进度清零回到 0:00（真机实测「转圈回到起点」的来源之一）。
    //      用户新投屏是全新 token，不会走到这里。
    //   c. bytes=0- / Range 落在会话之外 / 首次连接——全新下发
    let requested_offset = parse_range_start(&range);
    let session = TS_STREAM_STATES.lock().ok().and_then(|m| m.get(&token).cloned());
    let has_session_progress = session
        .as_ref()
        .map(|st| !st.served.is_empty() && st.total_bytes > 0)
        .unwrap_or(false);
    // VOD 重播检测：会话已把清单全部分片下发完、电视又无 Range 重连
    // = 用户按了重播，重置后从头下发（而不是续传到「已播完的末尾」）
    let replay_vod = endlist
        && session
            .as_ref()
            .map(|st| st.served.len() >= pending.len() && st.total_bytes > 0)
            .unwrap_or(false);
    let resume_offset = match requested_offset {
        Some(n) if n > 0 => Some(n),
        Some(_) => None, // bytes=0-：电视明确要完整重载，走全新下发
        None if has_session_progress && !replay_vod => {
            session.as_ref().map(|st| st.total_bytes)
        }
        None => None,
    };
    if let Some(n) = resume_offset {
        if let Some(st) = session.clone() {
            if let Some((idx, offset)) = locate_resume(&st, n) {
                let after_last = idx >= st.served.len();
                let anchor_url = if after_last {
                    st.served.last().map(|(u, _)| u.clone())
                } else {
                    st.served.get(idx).map(|(u, _)| u.clone())
                };
                if let Some(anchor) = anchor_url {
                    if let Some(p) = pending.iter().position(|q| *q == anchor) {
                        let drain_to = if after_last { p + 1 } else { p };
                        if drain_to <= pending.len() {
                            pending.drain(..drain_to);
                            resume_plan = Some((idx, offset));
                            resume_skip = offset;
                            resume_status = "206 Partial Content";
                            resume_content_range = format!("Content-Range: bytes {}-/*
", n);
                            // 种子集只含「已完整下发」的分片（0..idx）。
                            // 锚点分片（idx）是部分下发——剩余部分要写出，不能进去重集
                            resume_seed_urls = st
                                .served
                                .iter()
                                .take(idx.min(st.served.len()))
                                .map(|(u, _)| u.clone())
                                .collect();
                            if let Ok(mut map) = TS_STREAM_STATES.lock() {
                                if let Some(st) = map.get_mut(&token) {
                                    st.resume_hits += 1;
                                    st.connections += 1;
                                }
                            }
                        }
                    }
                }
            }
        }
        // Range 落在会话之外（对不上锚点）或 bytes=0-：全新下发（重置状态）
        if resume_plan.is_none() {
            if let Ok(mut map) = TS_STREAM_STATES.lock() {
                map.insert(
                    token.clone(),
                    TsStreamState { connections: 1, started_at: Some(Instant::now()), ..Default::default() },
                );
                ts_state_evict_extra(&mut map);
            }
        }
    } else {
        // 首次连接（会话不存在）：登记新会话并淘汰最不活跃的旧会话
        if let Ok(mut map) = TS_STREAM_STATES.lock() {
            if map.contains_key(&token) {
                if let Some(st) = map.get_mut(&token) {
                    st.connections += 1;
                }
            } else {
                ts_state_evict_extra(&mut map);
                map.insert(
                    token.clone(),
                    TsStreamState {
                        connections: 1,
                        started_at: Some(Instant::now()),
                        ..Default::default()
                    },
                );
            }
        }
    }

    let head = format!(
        "HTTP/1.1 {}\r\nContent-Type: {}\r\nCache-Control: no-store\r\n\
{}Accept-Ranges: bytes\r\ntransferMode.dlna.org: Streaming\r\ncontentFeatures.dlna.org: {}\r\nConnection: close\r\n\r\n",
        resume_status, ts_mime, resume_content_range, SAMSUNG_DLNA_FLAGS
    );
    stream
        .write_all(head.as_bytes())
        .await
        .map_err(|e| format!("写出响应头失败: {}", e))?;
    stream.flush().await.ok();

    let mut served: std::collections::HashSet<String> =
        resume_seed_urls.iter().cloned().collect();
    let mut consecutive_failures = 0usize;
    // 续传时首个写出分片的片内偏移：电视要第 N 字节起的数据，
    // 写出前先丢弃其之前的部分（同字节位置的同内容重发，无害）。
    let mut skip_now = resume_skip;
    // 预取管线：上游并行挂 TS_PREFETCH_DEPTH 个分片请求，写出严格按清单顺序。
    // 单连接串行时，任一分片的下载慢都会直接饿死电视缓冲（转圈）；
    // 并行预取把有效供给拉回多连接水平（与浏览器里 hls.js 的行为一致）。
    let mut pending: std::collections::VecDeque<String> = pending.into_iter().collect();
    // AbortOnDrop：serve_live_ts 无论从哪条路径返回（电视断开/错误/播完），
    // 未完成的预取任务都随 inflight 的 drop 自动取消——
    // 否则旧连接的最多 6 个下载继续占带宽，新连接又开 6 个抓同样的分片，
    // 12 次连接的带宽就这样被自己瓜分（外部审查实证）。
    struct AbortOnDrop<T>(tokio::task::JoinHandle<T>);
    impl<T> Drop for AbortOnDrop<T> {
        fn drop(&mut self) { self.0.abort(); }
    }
    let mut inflight: std::collections::VecDeque<
        (String, AbortOnDrop<Result<Vec<u8>, String>>),
    > = std::collections::VecDeque::new();
    loop {
        // 填满预取窗口
        while inflight.len() < TS_PREFETCH_DEPTH {
            let Some(seg) = pending.pop_front() else {
                break;
            };
            if !served.insert(seg.clone()) {
                continue; // 直播轮询时跳过已服务的分片
            }
            let upstream_task = upstream.clone();
            inflight.push_back((
                seg.clone(),
                AbortOnDrop(tokio::spawn(async move { fetch_segment_cached(seg, upstream_task).await })),
            ));
        }
        let Some((seg, mut handle)) = inflight.pop_front() else {
            // 本批分片已全部喂完
            if endlist {
                break; // VOD：整部播完
            }
            // 直播清单：隔 2 秒重取，把新分片继续喂给电视
            tokio::time::sleep(Duration::from_secs(2)).await;
            match fetch_media_playlist(&media_url, &upstream).await {
                Ok((next, e)) => {
                    pending.extend(next);
                    endlist = e;
                }
                Err(_) => continue, // 单次刷新失败不打断整条流
            }
            continue;
        };
        let data = match (&mut handle.0).await {
            Ok(Ok(data)) => {
                consecutive_failures = 0;
                data
            }
            Ok(Err(e)) => {
                consecutive_failures += 1;
                SKIPPED_SEGMENT_COUNT.fetch_add(1, Ordering::Relaxed);
                if consecutive_failures >= MAX_CONSECUTIVE_SEGMENT_FAILURES {
                    // 只有「放弃整条流」才算故障，才写进诊断的错误字段。
                    // 单片跳过不写：流还在正常往前走，写进去会让用户看到
                    // 「最近一次代理错误」有内容而误以为投屏失败了。
                    record_proxy_error(format!(
                        "TS 连续 {} 个分片失败，已放弃本条流（最后一片: {} — {}）",
                        consecutive_failures, seg, e
                    ));
                    return Err(format!(
                        "连续 {} 个分片失败，放弃本条流（最后一片: {}）",
                        consecutive_failures, seg
                    ));
                }
                // 单片坏不中断整条流：跳过继续喂下一片。
                // 断流会让电视重连并从头开始，那才是「投一会儿就中断」的来源。
                continue;
            }
            Err(_) => {
                // 预取任务自身异常（理论上不该发生），按坏分片处理
                consecutive_failures += 1;
                SKIPPED_SEGMENT_COUNT.fetch_add(1, Ordering::Relaxed);
                if consecutive_failures >= MAX_CONSECUTIVE_SEGMENT_FAILURES {
                    record_proxy_error(format!("TS 预取任务异常，已放弃本条流（分片: {}）", seg));
                    return Err(format!("预取任务异常，放弃本条流（分片: {}）", seg));
                }
                continue;
            }
        };
        // 佈局登记移到写之前：分片大小在下载时已知，与写出成功与否无关。
        // 以前在 write_all 之后登记——电视断在写一半时，已送出的部分没有
        // 被记录，重连 Range > total_bytes → locate_resume 回 None → 重置
        // 从 0 重发 → PTS 回跳 → 中止 → 无限循环（外部审查实证的根因）。
        if let Ok(mut map) = TS_STREAM_STATES.lock() {
            if let Some(st) = map.get_mut(&token) {
                if !st.served.iter().any(|(u, _)| *u == seg) {
                    st.total_bytes += data.len() as u64;
                    st.served.push((seg.clone(), data.len() as u64));
                }
            }
        }
        // 断点续传：丢弃电视已收到的字节（按字节位置精确对齐）
        let mut out: &[u8] = &data;
        if skip_now > 0 {
            let skip = (skip_now as usize).min(out.len());
            out = &out[skip..];
            skip_now -= skip as u64;
            if out.is_empty() {
                continue;
            }
        }
        // 写失败只可能是电视主动断开（切集/退出投屏），是正常结束。
        if stream.write_all(out).await.is_err() || stream.flush().await.is_err() {
            return Ok(());
        }
    }
    Ok(())
}

/// 这个分片是不是广告分片。
///
/// 两种写法都认：
///   - 清单里的原始字面量（相对路径就写相对路径）
///   - 解析后的绝对地址
///
/// 为什么要两种都认：前端把「要删的分片」传下来时，手里只有清单原文里的写法；
/// 而不同站点的广告地址形态不一（360zy 是绝对地址，部分站是相对路径）。
/// 只认一种就会漏删（漏删安全，但功能失效）；两种都认则两种形态都能命中。
/// 匹配用的是字面比较，不会出现「解析差异导致误判」—— 匹配不上就是匹配不上。
fn is_ad_segment(line: &str, resolved: &str, ad_uris: &[String]) -> bool {
    ad_uris
        .iter()
        .any(|u| u == line || u == resolved)
}

/// 把 m3u8 里的分片/密钥/子列表地址改写成本地代理地址，并剔除广告块。
///
/// ad_uris：前端判定好的广告分片地址。
/// 命中的块整块删掉 —— 只删其中的分片会留下半截广告；
/// 连块内的 KEY 行和断点一起删，否则会留下孤立的加密状态（后续分片解不开）。
///
/// 判据不在这里：广告块的识别由前端完成（见 Upstream.ad_uris 注释），
/// Rust 只负责按给定的地址列表执行剔除。
fn rewrite_playlist(text: &str, playlist_url: &str, ad_uris: &[String]) -> String {
    if ad_uris.is_empty() {
        // 无广告：走原来的纯改写路径，不改变任何输出
        return rewrite_playlist_plain(text, playlist_url);
    }
    // 清单头部（第一个分片行之前的行）无条件保留。
    //
    // 大量站源把广告直接贴在正片前面、且不加断点标记，于是 #EXTM3U、
    // #EXT-X-VERSION、#EXT-X-TARGETDURATION、#EXT-X-MEDIA-SEQUENCE 与广告分片
    // 同处第一块。整块删除会把清单头一起删掉，输出变成「不以 #EXTM3U 开头、
    // 没有 TARGETDURATION」的非法清单 —— 渲染端整份拒绝，表现为黑屏转圈。
    // 这些是全局标签，与后面跟哪个分片无关，因此单独取出、不参与块删除判定。
    let lines: Vec<&str> = text.lines().collect();
    // 边界取「第一个 #EXTINF」而不是「第一个分片行」：#EXTINF 是分片自己的属性，
    // 留在头部就成了「有 EXTINF 却没有分片」的孤立声明，时长统计与严格解析器会出错。
    let head_end = lines
        .iter()
        .position(|line| {
            let t = line.trim();
            t.starts_with("#EXTINF") || (!t.is_empty() && !t.starts_with('#'))
        })
        .unwrap_or(lines.len());
    let mut out = String::with_capacity(text.len() + 256);
    for line in &lines[..head_end] {
        // 头部也可能带 URI 属性（#EXT-X-KEY / #EXT-X-MAP，master 里的
        // #EXT-X-MEDIA / #EXT-X-I-FRAME-STREAM-INF），同样要走代理
        if line.trim().starts_with('#') && line.contains("URI=\"") {
            out.push_str(&rewrite_tag_uris(line, playlist_url));
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }

    let body = lines[head_end..].join("\n");
    let blocks = split_playlist_blocks(&body);
    let mut tail: Vec<&str> = Vec::new();
    let mut emitted = 0usize;
    for block in &blocks {
        // 整块删的条件：块内有分片，且块内每个分片都是广告分片。
        // 「每个」而不是「任一」：只要块里混了一个正片分片就整块保留 ——
        // 宁可漏删广告，也不能误删正片。
        let is_ad = !block.segments.is_empty()
            && block.segments.iter().all(|line| {
                let trimmed = line.trim();
                is_ad_segment(trimmed, &resolve_url(playlist_url, trimmed), ad_uris)
            });
        if is_ad {
            // 尾部广告块里带着 #EXT-X-ENDLIST，整块丢掉会连播放结束标记一起丢
            for line in &block.lines {
                if line.trim() == "#EXT-X-ENDLIST" {
                    tail.push(line);
                }
            }
            continue;
        }
        // 头一个分片之前不需要断点，写了反而是个孤立标记
        if block.discontinuity && emitted > 0 {
            out.push_str("#EXT-X-DISCONTINUITY\n");
        }
        for line in &block.lines {
            let trimmed = line.trim();
            let rewritten = if !trimmed.is_empty() && !trimmed.starts_with('#') {
                // 分片/子列表地址
                proxy_url_for(&resolve_url(playlist_url, trimmed))
            } else if trimmed.starts_with("#EXT-X-KEY") || trimmed.starts_with("#EXT-X-MAP") {
                // 密钥/初始化段的 URI="..." 属性也要走代理
                rewrite_tag_uris(line, playlist_url)
            } else {
                line.to_string()
            };
            out.push_str(&rewritten);
            out.push('\n');
        }
        emitted += block.segments.len();
    }
    for line in tail {
        out.push_str(line);
        out.push('\n');
    }
    // 兜底：名单把所有分片都删光时（判定出错 / 清单与名单不同源），
    // 剩下的只有头部标签，同样是非法清单。宁可让用户看广告，也不能黑屏。
    if !out.lines().any(|line| {
        let t = line.trim();
        !t.is_empty() && !t.starts_with('#')
    }) {
        return rewrite_playlist_plain(text, playlist_url);
    }
    out
}

/// 清单分块：按断点标记切开，每块记住原始行与其中的分片行。
struct PlaylistBlock {
    /// 该块前面是否有断点标记
    discontinuity: bool,
    /// 块内的原始行（含标签与分片行，不含断点标记本身）
    lines: Vec<String>,
    /// 块内分片行
    segments: Vec<String>,
}

fn split_playlist_blocks(text: &str) -> Vec<PlaylistBlock> {
    let mut blocks: Vec<PlaylistBlock> = Vec::new();
    let mut discontinuity = false;
    let mut lines: Vec<String> = Vec::new();
    let mut segments: Vec<String> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed == "#EXT-X-DISCONTINUITY" || trimmed.starts_with("#EXT-X-DISCONTINUITY:") {
            blocks.push(PlaylistBlock {
                discontinuity,
                lines: std::mem::take(&mut lines),
                segments: std::mem::take(&mut segments),
            });
            discontinuity = true;
            continue;
        }
        lines.push(line.to_string());
        if !trimmed.is_empty() && !trimmed.starts_with('#') {
            segments.push(line.to_string());
        }
    }
    blocks.push(PlaylistBlock {
        discontinuity,
        lines,
        segments,
    });
    blocks
}

/// 把 m3u8 里的分片/密钥/子列表地址改写成本地代理地址（不做广告过滤）。
fn rewrite_playlist_plain(text: &str, playlist_url: &str) -> String {
    let mut out = String::with_capacity(text.len() + 256);
    for line in text.lines() {
        let trimmed = line.trim();
        let rewritten_line = if !trimmed.is_empty() && !trimmed.starts_with('#') {
            // 分片/子列表地址
            let resolved = resolve_url(playlist_url, trimmed);
            proxy_url_for(&resolved)
        } else if trimmed.starts_with("#EXT-X-KEY") || trimmed.starts_with("#EXT-X-MAP") {
            // 密钥/初始化段的 URI="..." 属性也要走代理
            rewrite_tag_uris(line, playlist_url)
        } else {
            line.to_string()
        };
        out.push_str(&rewritten_line);
        out.push('\n');
    }
    out
}

/// 改写标签行里的 URI="..." 属性。
fn rewrite_tag_uris(line: &str, playlist_url: &str) -> String {
    let mut result = String::with_capacity(line.len() + 128);
    let mut rest = line;
    while let Some(pos) = rest.find("URI=\"") {
        let (before, after) = rest.split_at(pos);
        result.push_str(before);
        rest = &after["URI=\"".len()..];
        result.push_str("URI=\"");
        let end = match rest.find('"') {
            Some(e) => e,
            None => {
                result.push_str(rest);
                rest = "";
                break;
            }
        };
        let (uri, tail) = rest.split_at(end);
        let resolved = resolve_url(playlist_url, uri);
        result.push_str(&proxy_url_for(&resolved));
        result.push('"');
        rest = &tail[1..];
    }
    result.push_str(rest);
    result
}

/// 目标地址 -> 本地代理地址（带会话令牌）。
fn proxy_url_for(resolved: &str) -> String {
    let state = match PROXY.lock() {
        Ok(guard) => guard.as_ref().map(|s| (s.base.clone(), s.token.clone())),
        Err(_) => None,
    };
    match state {
        Some((base, token)) => format!(
            "{}/s/{}/{}",
            base,
            token,
            b64url_encode(resolved.as_bytes())
        ),
        None => resolved.to_string(),
    }
}

// ---------- Base64URL（不引依赖，手写标准实现） ----------

const B64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn b64url_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_ALPHABET[(triple >> 18) as usize & 0x3F] as char);
        out.push(B64_ALPHABET[(triple >> 12) as usize & 0x3F] as char);
        if chunk.len() > 1 {
            out.push(B64_ALPHABET[(triple >> 6) as usize & 0x3F] as char);
        }
        if chunk.len() > 2 {
            out.push(B64_ALPHABET[triple as usize & 0x3F] as char);
        }
    }
    out
}

fn b64url_decode(text: &str) -> Option<Vec<u8>> {
    let mut values = Vec::with_capacity(text.len());
    for ch in text.bytes() {
        if ch == b'=' {
            continue;
        }
        let value = match ch {
            b'A'..=b'Z' => (ch - b'A') as u32,
            b'a'..=b'z' => (ch - b'a' + 26) as u32,
            b'0'..=b'9' => (ch - b'0' + 52) as u32,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        };
        values.push(value);
    }
    let mut out = Vec::with_capacity(values.len() * 3 / 4);
    for group in values.chunks(4) {
        let mut triple = 0u32;
        for (index, value) in group.iter().enumerate() {
            triple |= value << (18 - index * 6);
        }
        out.push((triple >> 16) as u8);
        if group.len() > 2 {
            out.push((triple >> 8) as u8);
        }
        if group.len() > 3 {
            out.push(triple as u8);
        }
    }
    Some(out)
}

// 供测试：代理 URL 编解码 round-trip
#[cfg(test)]
mod tests {
    use super::*;

    /// 单个分片失败不能拖垮整条 TS 流。
    ///
    /// 这是「投一会儿就中断」「黑色转圈」的直接来源：以前分片失败用 `?` 向上
    /// 传播，整条连接立刻断开；电视看到流结束就重连，而重连后 `serve_live_ts`
    /// 从头解析清单、从第一个分片重来，于是反复倒在同一片坏分片上 ——
    /// 客户端看到的就是「转圈」或「播一会儿断了」，永远播不过去。
    #[tokio::test]
    async fn live_ts_skips_broken_segment_and_keeps_streaming() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // 上游：清单 4 片，第 2 片固定 403
        let up = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let up_addr = up.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = up.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                    let (code, body): (&str, &[u8]) = if path.contains("index.m3u8") {
                        (
                            "200 OK",
                            b"#EXTM3U\n#EXTINF:1,\nseg1.ts\n#EXTINF:1,\nseg2.ts\n\
                              #EXTINF:1,\nseg3.ts\n#EXTINF:1,\nseg4.ts\n#EXT-X-ENDLIST\n",
                        )
                    } else if path.contains("seg2") {
                        ("403 Forbidden", b"denied-body")
                    } else if path.contains("seg1") {
                        ("200 OK", b"SEG-ONE")
                    } else if path.contains("seg3") {
                        ("200 OK", b"SEG-THREE")
                    } else {
                        ("200 OK", b"SEG-FOUR")
                    };
                    let head = format!(
                        "HTTP/1.1 {}\r\nContent-Type: application/octet-stream\r\n\
                         Content-Length: {}\r\nConnection: close\r\n\r\n",
                        code,
                        body.len()
                    );
                    let _ = sock.write_all(head.as_bytes()).await;
                    let _ = sock.write_all(body).await;
                    let _ = sock.flush().await;
                });
            }
        });

        // 电视端：连上来取流
        let tv = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let tv_addr = tv.local_addr().unwrap();
        let target = format!("http://{}/index.m3u8", up_addr);
        let upstream = Arc::new(Upstream {
            referer: None,
            user_agent: None,
            cookie: None,
            token: "t".to_string(),
            is_samsung: false,
            ad_uris: Vec::new(),
        });
        let server = tokio::spawn(async move {
            let (sock, _) = tv.accept().await.unwrap();
            serve_live_ts(sock, "t".to_string(), target, upstream, None).await
        });

        let mut client = tokio::net::TcpStream::connect(tv_addr).await.unwrap();
        let mut out = Vec::new();
        client.read_to_end(&mut out).await.unwrap();
        let result = server.await.unwrap();
        let text = String::from_utf8_lossy(&out);

        assert!(result.is_ok(), "坏分片不应让整条流报错: {:?}", result);
        assert!(text.contains("SEG-ONE"), "首个分片应已下发");
        assert!(text.contains("SEG-THREE"), "坏分片之后应继续下发: {}", text);
        assert!(text.contains("SEG-FOUR"), "后续分片应全部下发: {}", text);
        assert!(
            !text.contains("denied-body"),
            "403 的响应体不该混进流里: {}",
            text
        );
    }

    #[test]
    fn b64url_roundtrip() {
        let samples = [
            "https://example.com/a/b/c.ts?token=abc&x=1",
            "https://example.com/中文/路径.m3u8",
            "",
            "a",
            "ab",
            "abc",
        ];
        for sample in samples {
            let encoded = b64url_encode(sample.as_bytes());
            assert!(!encoded.contains('+') && !encoded.contains('/'));
            let decoded = b64url_decode(&encoded).unwrap();
            assert_eq!(String::from_utf8(decoded).unwrap(), sample);
        }
    }

    #[test]
    fn resolve_url_variants() {
        // m3u8 改写语义：目录相对
        assert_eq!(
            resolve_url("http://a.b/c/d.m3u8", "e/f.ts"),
            "http://a.b/c/e/f.ts"
        );
        assert_eq!(
            resolve_url("http://a.b/c/d.m3u8", "/x/y.ts"),
            "http://a.b/x/y.ts"
        );
        assert_eq!(
            resolve_url("http://a.b/c/d.m3u8", "https://z.w/k.ts"),
            "https://z.w/k.ts"
        );
        // 大写 scheme 的绝对地址原样保留
        assert_eq!(
            resolve_url("http://a.b/x", "HTTP://z.w/k.ts"),
            "HTTP://z.w/k.ts"
        );
    }

    #[test]
    fn resolve_control_url_variants() {
        // swyh-rs 同款语义：根相对 + 补前导 '/'
        assert_eq!(
            resolve_control_url("http://192.168.1.2:7676/smp_6-", "/smp_9-"),
            "http://192.168.1.2:7676/smp_9-"
        );
        assert_eq!(
            resolve_control_url("http://192.168.1.2:7676", "dev/ctl"),
            "http://192.168.1.2:7676/dev/ctl"
        );
        assert_eq!(
            resolve_control_url("http://192.168.1.2:7676", "HTTP://192.168.1.2:49152/ctl"),
            "HTTP://192.168.1.2:49152/ctl"
        );
        assert_eq!(
            resolve_control_url("http://a.b/x", "//192.168.1.2:7676/ctl"),
            "http://192.168.1.2:7676/ctl"
        );
    }

    #[test]
    fn effective_base_validates_urlbase() {
        // URLBase 与 location 一致 → 采信
        assert_eq!(
            effective_base("http://192.168.1.2:7676/smp_6-", "http://192.168.1.2:7676"),
            "http://192.168.1.2:7676"
        );
        // URLBase 端口错报（Yamaha WXAD-10 类真实固件 bug）→ 回退 location
        assert_eq!(
            effective_base("http://192.168.1.50:80/desc.xml", "http://192.168.1.50:49152/"),
            "http://192.168.1.50:80"
        );
        // URLBase 缺失 → 回退 location
        assert_eq!(
            effective_base("http://192.168.1.2:7676/smp_6-", ""),
            "http://192.168.1.2:7676"
        );
    }

    #[test]
    fn playlist_rewrite() {
        let base = "http://192.168.1.5:12345".to_string();
        if let Ok(mut guard) = PROXY.lock() {
            *guard = Some(ProxyState { base, token: "test-token".to_string() });
        }
        let playlist = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:4,\nseg1.ts\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhi/index.m3u8\n";
        let rewritten = rewrite_playlist(playlist, "https://src.example.com/vod/list.m3u8", &[]);
        assert!(rewritten.contains("/s/")); // 分片与密钥都已改写
        assert!(rewritten.contains("#EXTINF:4,"));
        assert!(rewritten.starts_with("#EXTM3U"));
    }

    #[test]
    fn playlist_rewrite_removes_ad_block() {
        let base = "http://192.168.1.5:12345".to_string();
        if let Ok(mut guard) = PROXY.lock() {
            *guard = Some(ProxyState { base, token: "test-token".to_string() });
        }
        // 正片 → 广告块（KEY:NONE + 独立目录）→ 正片
        let playlist = "#EXTM3U\n\
                        #EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n\
                        #EXTINF:10,\n\
                        c1.ts\n\
                        #EXT-X-DISCONTINUITY\n\
                        #EXT-X-KEY:METHOD=NONE\n\
                        #EXTINF:5,\n\
                        ad1.ts\n\
                        #EXTINF:5,\n\
                        ad2.ts\n\
                        #EXT-X-DISCONTINUITY\n\
                        #EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n\
                        #EXTINF:10,\n\
                        c2.ts\n\
                        #EXT-X-ENDLIST\n";
        let ads = vec!["ad1.ts".to_string(), "ad2.ts".to_string()];
        let rewritten = rewrite_playlist(playlist, "https://src.example.com/vod/list.m3u8", &ads);
        // 分片地址会被改写成代理地址（b64），按「非标签行」统计分片个数
        let segment_lines: Vec<&str> = rewritten
            .lines()
            .filter(|l| {
                let t = l.trim();
                !t.is_empty() && !t.starts_with('#')
            })
            .collect();
        assert_eq!(segment_lines.len(), 2, "只应保留 2 个正片分片: {}", rewritten);
        assert!(!rewritten.contains("METHOD=NONE"), "广告块的明文 KEY 不应残留: {}", rewritten);
        // 断点数应与保留块数匹配（广告块前后的断点被合并）
        assert_eq!(rewritten.matches("#EXT-X-DISCONTINUITY").count(), 1, "{}", rewritten);
        assert!(rewritten.contains("#EXT-X-ENDLIST"), "播放结束标记应保留");
    }

    /// 片头广告：第一个块必须保留清单头部标签。
    ///
    /// 大量站源把广告直接贴在正片前面，没有断点标记，于是 #EXTM3U /
    /// #EXT-X-VERSION / #EXT-X-TARGETDURATION / #EXT-X-MEDIA-SEQUENCE
    /// 与广告分片同处「第一块」。整块删除会把这些标签一起删掉——
    /// 输出变成没有 #EXTM3U 开头、没有 TARGETDURATION 的非法清单，
    /// 电视拿到后解析失败，表现为黑屏转圈。
    #[test]
    fn playlist_rewrite_keeps_header_when_leading_block_is_ad() {
        let base = "http://192.168.1.5:12345".to_string();
        if let Ok(mut guard) = PROXY.lock() {
            *guard = Some(ProxyState { base, token: "test-token".to_string() });
        }
        let playlist = "#EXTM3U\n\
                        #EXT-X-VERSION:3\n\
                        #EXT-X-TARGETDURATION:10\n\
                        #EXT-X-PLAYLIST-TYPE:VOD\n\
                        #EXT-X-MEDIA-SEQUENCE:0\n\
                        #EXTINF:5,\n\
                        ad1.ts\n\
                        #EXTINF:5,\n\
                        ad2.ts\n\
                        #EXT-X-DISCONTINUITY\n\
                        #EXTINF:10,\n\
                        c1.ts\n\
                        #EXT-X-ENDLIST\n";
        let ads = vec!["ad1.ts".to_string(), "ad2.ts".to_string()];
        let rewritten = rewrite_playlist(playlist, "https://src.example.com/vod/list.m3u8", &ads);
        assert!(
            rewritten.starts_with("#EXTM3U"),
            "清单必须以 #EXTM3U 开头，否则渲染端整份拒绝: {}",
            rewritten
        );
        assert!(
            rewritten.contains("#EXT-X-TARGETDURATION"),
            "HLS 必需标签 TARGETDURATION 丢失: {}",
            rewritten
        );
        assert!(
            !rewritten.contains("ad1.ts") && !rewritten.contains("ad2.ts"),
            "广告分片仍应被剔除: {}",
            rewritten
        );
        // #EXTINF 必须与分片一一对应：留在头部会变成「有 EXTINF 没有分片」的孤立声明
        let seg_count = rewritten
            .lines()
            .filter(|l| {
                let t = l.trim();
                !t.is_empty() && !t.starts_with('#')
            })
            .count();
        assert_eq!(
            rewritten.matches("#EXTINF").count(),
            seg_count,
            "EXTINF 数与分片数不一致（有孤立 EXTINF）: {}",
            rewritten
        );
    }

    #[test]
    fn playlist_rewrite_keeps_ad_block_when_uri_mismatch() {
        let base = "http://192.168.1.5:12345".to_string();
        if let Ok(mut guard) = PROXY.lock() {
            *guard = Some(ProxyState { base, token: "test-token".to_string() });
        }
        // 广告地址对不上 → 不删任何东西（宁可漏删广告，不能删掉正片）
        let playlist = "#EXTM3U\n#EXTINF:10,\nc1.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:5,\nad1.ts\n";
        let ads = vec!["other.ts".to_string()];
        let rewritten = rewrite_playlist(playlist, "https://src.example.com/vod/list.m3u8", &ads);
        let segment_lines = rewritten
            .lines()
            .filter(|l| {
                let t = l.trim();
                !t.is_empty() && !t.starts_with('#')
            })
            .count();
        assert_eq!(segment_lines, 2, "两个分片都应保留: {}", rewritten);
    }

    #[test]
    fn url_host_ip_variants() {
        assert_eq!(
            url_host_ip("http://192.168.188.211:9197/dmr"),
            Some(IpAddr::V4(Ipv4Addr::new(192, 168, 188, 211)))
        );
        assert_eq!(
            url_host_ip("http://192.168.1.2/desc.xml"),
            Some(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 2)))
        );
        // 域名主机不解析成 IP，返回 None 走回退
        assert_eq!(url_host_ip("http://example.com:8080/x"), None);
    }

    #[test]
    fn parse_http_url_variants() {
        assert_eq!(
            parse_http_url("http://192.168.1.2:7676/smp_6-"),
            Some(("192.168.1.2".to_string(), 7676, "/smp_6-".to_string()))
        );
        assert_eq!(
            parse_http_url("http://192.168.1.2/desc.xml"),
            Some(("192.168.1.2".to_string(), 80, "/desc.xml".to_string()))
        );
        assert_eq!(
            parse_http_url("http://[fe80::1]:49152/ctl"),
            Some(("fe80::1".to_string(), 49152, "/ctl".to_string()))
        );
        assert_eq!(parse_http_url("https://a.b/ctl"), None);
        // 大写 scheme 与空端口
        assert_eq!(
            parse_http_url("HTTP://192.168.1.2:7676/ctl"),
            Some(("192.168.1.2".to_string(), 7676, "/ctl".to_string()))
        );
        assert_eq!(
            parse_http_url("http://192.168.1.2:/ctl"),
            Some(("192.168.1.2".to_string(), 80, "/ctl".to_string()))
        );
        // 非法端口（超 u16 范围）必须被拒绝——这正是本次线上故障的表象
        assert_eq!(parse_http_url("http://192.168.1.2:99999/ctl"), None);
    }

    #[test]
    fn dechunk_bodies() {
        assert_eq!(dechunk("4\r\nwiki\r\n5\r\npedia\r\n0\r\n\r\n"), "wikipedia");
        assert_eq!(dechunk("plain"), "plain");
    }

    #[test]
    fn fault_desc_extracted() {
        let fault = "<s:Envelope><s:Body><s:Fault><detail><UPnPError \
xmlns=\"urn:schemas-upnp-org:control-1-0\"><errorCode>402</errorCode>\
<errorDescription>Invalid Args</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>";
        assert_eq!(
            soap_fault_desc(fault).as_deref(),
            Some("UPnP 错误 402: Invalid Args")
        );
        assert_eq!(soap_fault_desc("<ok/>"), None);
    }

    #[test]
    fn set_uri_body_escapes_and_res() {
        let body = build_set_uri_body("https://a.b/c.m3u8?x=1&y=2", Some("测试影片"), true, None, true);
        // URL 的 & 已在各自插入处单独转义（设备端 XML 解析器必需）
        assert!(body.contains("&amp;y=2"));
        // DIDL 元数据必须原样嵌入真实标签：三星等从 CurrentURIMetaData 取播放地址，
        // 绝不能被整体再次转义成 &lt;DIDL-Lite&gt;（否则元数据解析失败、投屏黑屏）
        assert!(body.contains("<DIDL-Lite"));
        assert!(body.contains("<res protocolInfo="));
        assert!(!body.contains("&lt;DIDL-Lite"));
        assert!(!body.contains("&lt;res"));
        assert!(body.contains("application/vnd.apple.mpegurl"));
        // 协议声明覆盖：TS 串流梯度必须声明三星 DLNA 专用 MIME（video/vnd.dlna.mpeg-tts），
        // 且 DIDL protocolInfo 第 4 段携带 DLNA flags（不再是无意义的 "*"）
        let ts = build_set_uri_body("https://a.b/c.m3u8", None, true, Some("video/vnd.dlna.mpeg-tts"), true);
        assert!(ts.contains("video/vnd.dlna.mpeg-tts"));
        assert!(ts.contains(SAMSUNG_DLNA_FLAGS));
        assert!(!ts.contains("apple.mpegurl"));
        // 无元数据版本不含 res
        let bare = build_set_uri_body("https://a.b/c.m3u8", None, false, None, true);
        assert!(!bare.contains("DIDL-Lite"));
    }

    #[test]
    fn cast_ladder_candidates() {
        // m3u8 源应产生「自动 + mp2t」两个协议候选；直链只产生自动
        let is_hls = |url: &str| {
            let lower = url.to_ascii_lowercase();
            let clean = lower.split(|c| c == '?' || c == '#').next().unwrap_or(&lower);
            !clean.ends_with(".mp4")
                && !clean.ends_with(".mkv")
                && !clean.ends_with(".avi")
                && !clean.ends_with(".ts")
                && !clean.ends_with(".flv")
                && !clean.ends_with(".webm")
        };
        assert!(is_hls("https://a.b/vod/index.m3u8?token=x"));
        assert!(!is_hls("https://a.b/vod/movie.mp4"));
        assert!(!is_hls("https://a.b/vod/movie.MP4?sign=1"));
    }

    #[test]
    fn parse_media_playlist_vod() {
        let text = "#EXTM3U\n\
                    #EXT-X-TARGETDURATION:10\n\
                    #EXT-X-KEY:METHOD=NONE\n\
                    #EXTINF:10,\n\
                    seg001.ts\n\
                    #EXTINF:10,\n\
                    /abs/dir/seg002.ts\n\
                    #EXTINF:10,\n\
                    https://other.cdn/seg003.ts\n\
                    #EXT-X-ENDLIST\n";
        let (segments, endlist) =
            parse_media_playlist(text, "https://a.b/vod/index.m3u8", &[]).expect("parse ok");
        assert!(endlist);
        assert_eq!(segments.len(), 3);
        assert_eq!(segments[0], "https://a.b/vod/seg001.ts"); // 目录相对
        assert_eq!(segments[1], "https://a.b/abs/dir/seg002.ts"); // 根相对
        assert_eq!(segments[2], "https://other.cdn/seg003.ts"); // 绝对地址
    }

    #[test]
    fn parse_media_playlist_live_has_no_endlist() {
        let text = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nlive.ts\n";
        let (segments, endlist) =
            parse_media_playlist(text, "http://a.b/live.m3u8", &[]).expect("parse ok");
        assert!(!endlist);
        assert_eq!(segments, vec!["http://a.b/live.ts".to_string()]);
    }

    #[test]
    fn parse_media_playlist_rejects_encryption() {
        let text = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:10,\nseg.ts\n";
        let err = parse_media_playlist(text, "https://a.b/v.m3u8", &[]).unwrap_err();
        assert!(err.contains("AES-128"), "报错应带加密方法: {}", err);
    }

    #[test]
    fn parse_media_playlist_rejects_fmp4() {
        let text = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:10,\nseg.m4s\n";
        let err = parse_media_playlist(text, "https://a.b/v.m3u8", &[]).unwrap_err();
        assert!(err.contains("fMP4"), "报错应说明 fMP4: {}", err);
    }

    #[test]
    fn parse_media_playlist_skips_ad_segments() {
        // 广告分片由前端判定后传下来，TS 串流路径必须跳过它们
        let text = "#EXTM3U\n\
                    #EXT-X-TARGETDURATION:10\n\
                    #EXTINF:10,\n\
                    seg001.ts\n\
                    #EXTINF:10,\n\
                    ad001.ts\n\
                    #EXTINF:10,\n\
                    seg002.ts\n";
        let ads = vec!["https://a.b/vod/ad001.ts".to_string()];
        let (segments, _) =
            parse_media_playlist(text, "https://a.b/vod/index.m3u8", &ads).expect("parse ok");
        assert_eq!(segments.len(), 2, "广告分片应被剔除");
        assert!(!segments.iter().any(|s| s.ends_with("ad001.ts")));
    }

    #[test]
    fn pick_variant_first_stream_inf() {
        let master = "#EXTM3U\n\
                      #EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\n\
                      360p/index.m3u8\n\
                      #EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080\n\
                      1080p/index.m3u8\n";
        assert_eq!(
            pick_variant(master, "https://a.b/hls/master.m3u8").as_deref(),
            Some("https://a.b/hls/360p/index.m3u8")
        );
        // STREAM-INF 后跟注释行应跳过，直到取到 URI 行
        let master2 = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n## comment\n\nhi/index.m3u8\n";
        assert_eq!(
            pick_variant(master2, "https://a.b/hls/master.m3u8").as_deref(),
            Some("https://a.b/hls/hi/index.m3u8")
        );
        assert_eq!(pick_variant("#EXTM3U\n", "https://a.b/m.m3u8"), None);
    }

    #[test]
    fn classify_playlist_kinds() {
        let media = "#EXTM3U\n#EXTINF:10,\nseg.ts\n#EXT-X-ENDLIST\n";
        assert!(matches!(
            classify_playlist(media, "https://a.b/v.m3u8"),
            Ok(PlaylistKind::Media)
        ));
        let master = "#EXT-X-STREAM-INF:BANDWIDTH=1\nsub/index.m3u8\n";
        assert!(matches!(
            classify_playlist(master, "https://a.b/m.m3u8"),
            Ok(PlaylistKind::Master(_))
        ));
        // 非 HLS 内容 → Unknown
        assert!(matches!(
            classify_playlist("<html>not a playlist</html>", "https://a.b/x"),
            Ok(PlaylistKind::Unknown)
        ));
    }

    #[test]
    fn prefix_bits_regression() {
        // 回归：同网段网卡必须胜过蜂窝/虚拟网卡（真实案例 2026-11-03 安卓报告）
        let dev: Ipv4Addr = "192.168.188.211".parse().unwrap();
        let wlan: Ipv4Addr = "192.168.188.223".parse().unwrap();
        let rmnet: Ipv4Addr = "10.30.79.247".parse().unwrap();
        let vpn: Ipv4Addr = "192.168.82.2".parse().unwrap();
        // 211=11010011 vs 223=11011111：末字节第 3 位（值 8）起不同 → 相同前缀 28 位
        assert_eq!(same_prefix_bits(dev, wlan), 28, "同网段应匹配 28 位");
        // 188=10111100 vs 10=00001010：最高位即不同 → 0 位
        assert_eq!(same_prefix_bits(dev, rmnet), 0, "跨网段首位即不同");
        assert!(same_prefix_bits(dev, wlan) > same_prefix_bits(dev, rmnet));
        assert!(same_prefix_bits(dev, wlan) > same_prefix_bits(dev, vpn));
        assert_eq!(same_prefix_bits(dev, dev), 32);
        // 两个历史错误公式的对照（安卓实测各翻过一次车）：都把同网段算成 0
        let wrong1 = |a: Ipv4Addr, b: Ipv4Addr| (!u32::from(a) ^ u32::from(b)).leading_zeros();
        let wrong2 = |a: Ipv4Addr, b: Ipv4Addr| (!(u32::from(a) ^ u32::from(b))).leading_zeros();
        assert_ne!(wrong1(dev, wlan), same_prefix_bits(dev, wlan));
        assert_ne!(wrong2(dev, wlan), same_prefix_bits(dev, wlan));
    }
}

// ---------- 投屏端到端实证（默认 ignore：依赖真实网络，CI 不跑；本机验证用） ----------
//
// 运行方式：
//   cargo test --lib cast_e2e -- --ignored --nocapture
//
// 覆盖的正是真机上「网络视频投屏」的完整链路（不含真实电视硬件）：
//   假三星 DMR(9197) ←SOAP← cast_to_device → 本机代理 → 模拟电视 HEAD/GET 取流
// 抓下来的 TS 落盘到 target/cast_e2e_capture.ts，可用 ffprobe/ffmpeg 事后校验
// 可解码性与 PTS 连续性（电视端黑屏转圈的最常见成因就在这两点）。
//
// 本模块的假渲染器同时服务于普通单测（起播验证/预取顺序，绑定临时端口，
// 不依赖真实网络，随 CI 跑）——见 verify_playback_* / prefetch_* 测试。
#[cfg(test)]
mod cast_e2e {
    use super::*;
    use std::io::Write as IoWrite;

    const E2E_DEFAULT_URL: &str = "https://vip.dytt-hot.com/20250213/72013_e835617a/index.m3u8";

    fn e2e_url() -> String {
        std::env::var("CAST_E2E_URL").unwrap_or_else(|_| E2E_DEFAULT_URL.to_string())
    }

    fn xml_unescape(value: &str) -> String {
        value
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'")
            .replace("&amp;", "&")
    }

    /// 假渲染器的传输状态脚本：GetTransportInfo 按此应答。
    /// 用于验证起播轮询对「起播/拒收/永远缓冲」三种真实电视行为的判定。
    #[derive(Clone, Copy, PartialEq)]
    enum FakeTvBehavior {
        /// Play 之后进入 PLAYING（正常起播的电视）
        PlaysAfterSet,
        /// 停在 STOPPED 并报 ERROR_OCCURRED（拒收内容的电视）
        ErrorsOut,
        /// 永远 TRANSITIONING（一直在缓冲的电视）
        StuckTransitioning,
    }

    struct FakeRenderer {
        /// SetAVTransportURI 收到的 CurrentURI（XML 反转义后）
        current_uri: Arc<Mutex<Option<String>>>,
        /// SetAVTransportURI 收到的完整 body（供校验 DIDL/protocolInfo）
        set_body: Arc<Mutex<String>>,
    }

    /// 起一个最小 DLNA DMR 模拟器。port 传 9197 即命中三星画像判定（is_samsung_renderer），
    /// 单测传 0（系统分配临时端口，多个测试并行互不冲突）。
    async fn spawn_fake_renderer(port: u16, behavior: FakeTvBehavior) -> (String, FakeRenderer) {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .expect("绑定模拟渲染器端口失败");
        let actual_port = listener.local_addr().unwrap().port();
        let current_uri = Arc::new(Mutex::new(None::<String>));
        let set_body = Arc::new(Mutex::new(String::new()));
        let play_called = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let uri_slot = current_uri.clone();
        let body_slot = set_body.clone();
        let play_slot = play_called.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let uri_slot = uri_slot.clone();
                let body_slot = body_slot.clone();
                let play_slot = play_slot.clone();
                tauri::async_runtime::spawn(async move {
                    let mut buf = vec![0u8; 256 * 1024];
                    let mut received = 0usize;
                    // 读到请求头结束
                    let head_end = loop {
                        if let Some(pos) = buf[..received]
                            .windows(4)
                            .position(|w| w == b"\r\n\r\n")
                        {
                            break pos;
                        }
                        if received >= buf.len() {
                            return;
                        }
                        let n = sock.read(&mut buf[received..]).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        received += n;
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                    // 按 Content-Length 读满 body
                    let content_length = head
                        .to_ascii_lowercase()
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                        .and_then(|v| v.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    let body_start = head_end + 4;
                    while received < body_start + content_length {
                        let n = sock
                            .read(&mut buf[received..])
                            .await
                            .unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        received += n;
                    }
                    let body = String::from_utf8_lossy(&buf[body_start..received]).to_string();
                    let soap_action = head
                        .lines()
                        .find(|l| l.to_ascii_lowercase().starts_with("soapaction:"))
                        .unwrap_or_default()
                        .split('#')
                        .nth(1)
                        .unwrap_or_default()
                        .trim_matches('"')
                        .to_string();
                    if soap_action == "SetAVTransportURI" {
                        let mut delivered = String::new();
                        if let Some(start) = body.find("<CurrentURI>") {
                            let rest = &body[start + "<CurrentURI>".len()..];
                            if let Some(end) = rest.find("</CurrentURI>") {
                                delivered = xml_unescape(rest[..end].trim()).to_string();
                                *uri_slot.lock().unwrap() = Some(delivered.clone());
                            }
                        }
                        *body_slot.lock().unwrap() = body.clone();
                        // 像真电视一样在 Set 后立即取流（真机会在验证窗口内连接代理；
                        // 这也让 0 连接守卫在测试里语义正确——只有假接收端才会 0 连接）
                        if !delivered.is_empty() {
                            if let Some((host, port, path)) = parse_http_url(&delivered) {
                                tauri::async_runtime::spawn(async move {
                                    let connected = tokio::net::TcpStream::connect((host.as_str(), port)).await;

                                    if let Ok(mut s) = connected
                                    {
                                        let req = format!(
                                            "GET {} HTTP/1.1
Host: {}
Range: bytes=0-65535
Connection: close

",
                                            path,
                                            host_header(&host, port)
                                        );
                                        use tokio::io::AsyncWriteExt;
                                        let _ = s.write_all(req.as_bytes()).await;
                                        // 写完立即断开（FIN）：目的是让代理连接计数 +1；
                                        // 不读响应，避免与代理的头部读取互相等待
                                    }
                                });
                            }
                        }
                    }
                    // 响应体：控制类指令回通用应答；GetTransportInfo 按脚本回传输状态
                    let resp_body = if soap_action == "GetTransportInfo" {
                        play_slot.store(true, std::sync::atomic::Ordering::Relaxed);
                        let (state, status) = match behavior {
                            FakeTvBehavior::PlaysAfterSet => {
                                ("PLAYING", "OK")
                            }
                            FakeTvBehavior::ErrorsOut => ("STOPPED", "ERROR_OCCURRED"),
                            FakeTvBehavior::StuckTransitioning => ("TRANSITIONING", "OK"),
                        };
                        format!(
                            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\
<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" \
s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">\
<s:Body><u:GetTransportInfoResponse \
xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">\
<CurrentTransportState>{}</CurrentTransportState>\
<CurrentTransportStatus>{}</CurrentTransportStatus>\
<CurrentSpeed>1</CurrentSpeed>\
</u:GetTransportInfoResponse></s:Body></s:Envelope>",
                            state, status
                        )
                    } else {
                        let action = if soap_action.is_empty() {
                            "Unknown"
                        } else {
                            &soap_action
                        };
                        if soap_action == "Play" {
                            play_slot.store(true, std::sync::atomic::Ordering::Relaxed);
                        }
                        format!(
                            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\
<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" \
s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">\
<s:Body><u:{action}Response xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">\
</u:{action}Response></s:Body></s:Envelope>",
                            action = action
                        )
                    };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/xml; charset=\"utf-8\"\r\n\
Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                        resp_body.len(),
                        resp_body
                    );
                    let _ = sock.write_all(response.as_bytes()).await;
                    let _ = sock.flush().await;
                });
            }
        });
        (
            format!("http://127.0.0.1:{}/dev/ctl", actual_port),
            FakeRenderer {
                current_uri,
                set_body,
            },
        )
    }

    // ---- 起播验证（普通单测，CI 可跑）----

    #[tokio::test]
    async fn verify_playback_detects_playing() {
        let (control_url, _renderer) =
            spawn_fake_renderer(0, FakeTvBehavior::PlaysAfterSet).await;
        let verdict = verify_playback_started_with(&control_url, 3).await;
        assert_eq!(verdict, PlayVerdict::Playing);
    }

    #[tokio::test]
    async fn verify_playback_detects_error() {
        let (control_url, _renderer) = spawn_fake_renderer(0, FakeTvBehavior::ErrorsOut).await;
        let verdict = verify_playback_started_with(&control_url, 5).await;
        assert!(
            matches!(verdict, PlayVerdict::Error(_)),
            "拒收型电视应判 Error: {:?}",
            verdict
        );
    }

    #[tokio::test]
    async fn verify_playback_times_out_to_buffering() {
        let (control_url, _renderer) =
            spawn_fake_renderer(0, FakeTvBehavior::StuckTransitioning).await;
        let verdict = verify_playback_started_with(&control_url, 3).await;
        assert_eq!(verdict, PlayVerdict::Buffering);
    }

    // ---- 预取管线（普通单测，CI 可跑）----

    /// 预取必须按清单顺序写出，哪怕后发分片先到（上游延迟故意倒挂）。
    #[tokio::test]
    async fn prefetch_writes_segments_in_order() {
        let up = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let up_addr = up.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = up.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                    // 清单请求先行；片号越大延迟越短：后发先至，考验写出顺序
                    let (body, delay_ms): (&[u8], u64) = if path.contains("index.m3u8") {
                        (
                            b"#EXTM3U\n#EXTINF:1,\nseg1.ts\n#EXTINF:1,\nseg2.ts\n\
                              #EXTINF:1,\nseg3.ts\n#EXTINF:1,\nseg4.ts\n#EXT-X-ENDLIST\n",
                            0,
                        )
                    } else if path.contains("seg1") {
                        (&b"MARK-ONE"[..], 300)
                    } else if path.contains("seg2") {
                        (&b"MARK-TWO"[..], 200)
                    } else if path.contains("seg3") {
                        (&b"MARK-THREE"[..], 100)
                    } else {
                        (&b"MARK-FOUR"[..], 0)
                    };
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\n\
                         Content-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = sock.write_all(head.as_bytes()).await;
                    let _ = sock.write_all(body).await;
                    let _ = sock.flush().await;
                });
            }
        });

        let tv = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let tv_addr = tv.local_addr().unwrap();
        let target = format!("http://{}/index.m3u8", up_addr);
        let upstream = Arc::new(Upstream {
            referer: None,
            user_agent: None,
            cookie: None,
            token: "t".to_string(),
            is_samsung: false,
            ad_uris: Vec::new(),
        });
        let server = tokio::spawn(async move {
            let (sock, _) = tv.accept().await.unwrap();
            serve_live_ts(sock, "t".to_string(), target, upstream, None).await
        });

        let mut client = tokio::net::TcpStream::connect(tv_addr).await.unwrap();
        let mut out = Vec::new();
        client.read_to_end(&mut out).await.unwrap();
        server.await.unwrap().unwrap();
        let text = String::from_utf8_lossy(&out).to_string();
        // 写出顺序必须严格等于清单顺序
        let one = text.find("MARK-ONE").expect("应包含 seg1");
        let two = text.find("MARK-TWO").expect("应包含 seg2");
        let three = text.find("MARK-THREE").expect("应包含 seg3");
        let four = text.find("MARK-FOUR").expect("应包含 seg4");
        assert!(one < two && two < three && three < four, "写出顺序应与清单一致");
    }

    /// 预热缓存命中时不打上游（上游不可达也能取到预热分片）。
    #[tokio::test]
    async fn prime_cache_feeds_without_upstream() {
        let seg_url = "http://127.0.0.1:1/never-listening/seg.ts".to_string();
        let data = b"PRIMED-BYTES".to_vec();
        TS_PRIME.lock().unwrap().clear();
        TS_PRIME.lock().unwrap().insert(seg_url.clone(), data.clone());
        let upstream = Arc::new(Upstream {
            referer: None,
            user_agent: None,
            cookie: None,
            token: "t".to_string(),
            is_samsung: false,
            ad_uris: Vec::new(),
        });
        let got = fetch_segment_cached(seg_url.clone(), upstream).await.unwrap();
        assert_eq!(got, data, "应直接命中预热缓存");
        assert!(pop_prime_segment(&seg_url).is_none(), "取出即删，不重复消费");
    }

    // ---- 真实网络端到端（#[ignore]，本机验证用）----

    /// 完整链路实证：cast_to_device（真实代码）→ 假三星接受 → 模拟电视取流 20 秒。
    /// 断言：投屏成功走 TS 串流、HEAD 合规、字节流持续且同步字节规整。
    #[tokio::test]
    #[ignore]
    async fn e2e_real_source_full_chain() {
        let (control_url, renderer) = spawn_fake_renderer(9197, FakeTvBehavior::PlaysAfterSet).await;
        let result = cast_to_device(
            control_url.clone(),
            e2e_url(),
            Some("E2E 测试".to_string()),
            None,
            None,
            None,
            None,
            None,
        )
        .await;
        assert!(result.is_ok(), "cast_to_device 应成功: {:?}", result.err());
        let playback_url = result.unwrap();
        println!("[E2E] 下发给电视的地址: {}", playback_url);
        assert!(playback_url.contains("/live.ts?u="), "HLS 源应走 TS 串流梯度");
        let cast_info = last_cast_info();
        println!("[E2E] 投屏状态: {}", cast_info);
        assert!(cast_info.contains("电视已起播"), "假渲染器应回报起播: {}", cast_info);

        let set_body = renderer.set_body.lock().unwrap().clone();
        assert!(
            set_body.contains("video/vnd.dlna.mpeg-tts"),
            "三星画像 DIDL 应声明 DLNA 专用 TS MIME"
        );
        let delivered = renderer
            .current_uri
            .lock()
            .unwrap()
            .clone()
            .expect("模拟渲染端应收到 CurrentURI");
        assert_eq!(delivered, playback_url, "电视收到的地址应与下发一致");

        let (head_status, _get_status, head_text, ttfb, total, max_gap, sync_ok) =
            tv_fetch_like_samsung(&playback_url, 20, &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("cast_e2e_capture.ts")).await;
        println!("[E2E] HEAD: {}", head_status);
        println!("[E2E] HEAD 头:\n{}", head_text);
        println!(
            "[E2E] 取流: 首字节 {:.2}s, 共 {} 字节, 平均 {:.0} KB/s, 最大读间隔 {:.2}s, 同步字节规整: {}",
            ttfb,
            total,
            total as f64 / 20.0 / 1024.0,
            max_gap,
            sync_ok
        );
        assert!(head_status.starts_with("HTTP/1.1 200"), "HEAD 探测应 200");
        assert!(
            head_text.to_ascii_lowercase().contains("contentfeatures.dlna.org"),
            "HEAD 响应应带 contentFeatures 头"
        );
        assert!(ttfb < 5.0, "预热后首字节应明显快于旧实现（<5s），实测 {:.2}s", ttfb);
        assert!(total > 2 * 1024 * 1024, "20 秒应至少拉到 2MB（约 2 倍实时供给），实测 {} 字节", total);
        assert!(max_gap < 10.0, "不应出现 10 秒级断供（电视会饿死转圈），实测 {:.2}s", max_gap);
        assert!(sync_ok, "TS 同步字节（188 字节对齐 0x47）应规整——乱流电视直接拒播");
    }

    /// 多源投屏模拟：CAST_E2E_URL_FILE 指向「label|url」行列表（url 可指向本机
    /// 通用镜像 http://127.0.0.1:18500/<目标>，出网传输由镜像代办，其余链路全真实），
    /// 对每个源跑完整 cast_to_device → HEAD/GET 取流，逐源分类汇报。
    ///
    /// 分类口径：
    ///   PASS        —— TS 串流 200、供给与同步字节健康
    ///   SOURCE-DOWN —— 上游 502/拉不到（源站自身不可用，非投屏链路问题）
    ///   FAIL        —— 链路问题：TS 200 但供给过慢 / 同步字节乱 / 停摆（必须修的）
    #[tokio::test]
    #[ignore]
    async fn e2e_multi_source_simulation() {
        let list_path = std::env::var("CAST_E2E_URL_FILE").expect("需要 CAST_E2E_URL_FILE");
        let content = std::fs::read_to_string(&list_path).expect("读取 URL 列表失败");
        let entries: Vec<(String, String)> = content
            .lines()
            .filter_map(|l| {
                let l = l.trim();
                if l.is_empty() || l.starts_with('#') {
                    return None;
                }
                let (label, url) = l.split_once('|')?;
                Some((label.trim().to_string(), url.trim().to_string()))
            })
            .collect();
        assert!(!entries.is_empty(), "URL 列表为空");
        let secs: u64 = std::env::var("CAST_E2E_SECONDS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(8);
        let (control_url, _renderer) =
            spawn_fake_renderer(9197, FakeTvBehavior::PlaysAfterSet).await;

        let captures_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("cast_captures");
        let _ = std::fs::create_dir_all(&captures_dir);

        let mut summary: Vec<String> = Vec::new();
        let (mut pass, mut source_down, mut fail) = (0usize, 0usize, 0usize);
        let mut fail_lines: Vec<String> = Vec::new();
        for (label, url) in &entries {
            let cast = cast_to_device(
                control_url.clone(),
                url.clone(),
                Some(label.clone()),
                None,
                None,
                None,
                None,
                None,
            )
            .await;
            let playback_url = match cast {
                Err(e) => {
                    fail += 1;
                    let line = format!("FAIL(cast) [{}] {}", label, e.chars().take(100).collect::<String>());
                    fail_lines.push(line.clone());
                    summary.push(line);
                    continue;
                }
                Ok(u) => u,
            };
            let safe_label: String = label
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
                .collect();
            let cap = captures_dir.join(format!("{}.ts", safe_label));
            let (_h_status, get_status, _head, ttfb, total, max_gap, sync_ok) =
                tv_fetch_like_samsung(&playback_url, secs, &cap).await;
            // 502 = 上游拉不到（镜像回传的源站错误），属源站问题
            if get_status.contains("502") {
                source_down += 1;
                let body = std::fs::read_to_string(&cap).unwrap_or_default();
                let reason: String = body.chars().take(90).collect();
                summary.push(format!("SOURCE-DOWN [{}] {}", label, reason));
                continue;
            }
            if !get_status.starts_with("HTTP/1.1 200") && !get_status.starts_with("HTTP/1.0 200") {
                fail += 1;
                let line = format!("FAIL(status) [{}] GET 状态: {}", label, get_status);
                fail_lines.push(line.clone());
                summary.push(line);
                continue;
            }
            let min_bytes = 300 * 1024 * secs as usize / 8; // ≈0.3Mbps 的极低供给下限
            if total < min_bytes {
                fail += 1;
                let line = format!(
                    "FAIL(feed) [{}] {} 秒仅取到 {} 字节（<{:.0}KB/s），TTFB {:.2}s, 最大间隔 {:.2}s",
                    label, secs, total, total as f64 / secs as f64 / 1024.0, ttfb, max_gap
                );
                fail_lines.push(line.clone());
                summary.push(line);
                continue;
            }
            if !sync_ok {
                fail += 1;
                let line = format!("FAIL(sync) [{}] TS 同步字节不规整（188 对齐 0x47）", label);
                fail_lines.push(line.clone());
                summary.push(line);
                continue;
            }
            pass += 1;
            summary.push(format!(
                "PASS [{}] {}s 取到 {:.1}MB（{:.0}KB/s）TTFB {:.2}s 最大间隔 {:.2}s",
                label, secs, total as f64 / 1048576.0, total as f64 / secs as f64 / 1024.0, ttfb, max_gap
            ));
        }
        println!("\n===== 多源投屏模拟（{} 源 × {}s）=====", entries.len(), secs);
        for line in &summary {
            println!("{}", line);
        }
        println!(
            "===== 汇总: PASS {} / SOURCE-DOWN {} / FAIL {} =====",
            pass, source_down, fail
        );
        assert!(
            fail == 0,
            "存在投屏链路自身的问题（FAIL）:\n{}",
            fail_lines.join("\n")
        );
    }

    /// 模拟电视取流：HEAD 探测 → GET 读取 capture_seconds 秒。
    /// 返回 (HEAD 状态行, GET 状态行, HEAD 头文本, 首字节耗时, 总字节, 最大读间隔, 是否同步字节规整)。
    async fn tv_fetch_like_samsung(
        url: &str,
        capture_seconds: u64,
        capture_path: &std::path::Path,
    ) -> (String, String, String, f64, usize, f64, bool) {
        let (host, port, path) = parse_http_url(url).expect("live.ts URL 应可解析");
        // ---- HEAD 探测（三星在 SetAVTransportURI 前的行为）----
        let mut sock = tokio::net::TcpStream::connect((host.as_str(), port))
            .await
            .expect("电视连接代理失败");
        let head_req = format!("HEAD {} HTTP/1.1\r\nHost: {}\r\ngetcontentFeatures.dlna.org: 1\r\nConnection: close\r\n\r\n", path, host_header(&host, port));
        sock.write_all(head_req.as_bytes()).await.unwrap();
        let mut head_resp = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = sock.read(&mut chunk).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            head_resp.extend_from_slice(&chunk[..n]);
        }
        let head_text = String::from_utf8_lossy(&head_resp).to_string();
        let head_status = head_text.lines().next().unwrap_or_default().to_string();

        // ---- GET 取流（带 Range，模拟三星实际取流行为）----
        let mut sock = tokio::net::TcpStream::connect((host.as_str(), port))
            .await
            .expect("电视连接代理失败");
        let get_req = format!(
            "GET {} HTTP/1.1\r\nHost: {}\r\nRange: bytes=0-\r\ngetcontentFeatures.dlna.org: 1\r\nConnection: close\r\n\r\n",
            path,
            host_header(&host, port)
        );
        sock.write_all(get_req.as_bytes()).await.unwrap();

        let started = Instant::now();
        let mut first_byte_at: Option<Instant> = None;
        let mut max_gap = 0f64;
        let mut last_read = started;
        let mut total = 0usize;
        let mut sync_ok = true;
        let mut get_status = String::new();
        let mut body_started = false; // 首个读块含 HTTP 响应头，剥离后再做 TS 对齐检查
        let deadline = started + Duration::from_secs(capture_seconds);
        let mut out = std::fs::File::create(capture_path).expect("创建抓流文件失败");
        loop {
            if Instant::now() >= deadline {
                break;
            }
            match tokio::time::timeout(Duration::from_secs(15), sock.read(&mut chunk)).await {
                Err(_) => {
                    max_gap = max_gap.max(last_read.elapsed().as_secs_f64());
                    break; // 15 秒没有任何数据 = 流停摆
                }
                Ok(Ok(0)) => break, // 服务端关流
                Ok(Ok(n)) => {
                    let now = Instant::now();
                    if first_byte_at.is_none() {
                        first_byte_at = Some(now);
                    } else {
                        max_gap = max_gap.max((now - last_read).as_secs_f64());
                    }
                    last_read = now;
                    let mut data = &chunk[..n];
                    if !body_started {
                        match data
                            .windows(4)
                            .position(|w| w == b"\r\n\r\n")
                        {
                            Some(pos) => {
                                get_status = String::from_utf8_lossy(&data[..pos])
                                    .lines()
                                    .next()
                                    .unwrap_or_default()
                                    .to_string();
                                data = &data[pos + 4..];
                                body_started = true;
                            }
                            None => data = &[], // 头还没读完
                        }
                    }
                    // MPEG-TS 同步字节：188 字节包，0x47 起始
                    for (i, b) in data.iter().enumerate() {
                        let offset = (total + i) % 188;
                        if offset == 0 && *b != 0x47 {
                            sync_ok = false;
                            break;
                        }
                    }
                    out.write_all(data).unwrap();
                    total += data.len();
                }
                Ok(Err(e)) => panic!("读流出错: {}", e),
            }
        }
        out.flush().ok();
        (
            head_status,
            get_status,
            head_text,
            first_byte_at.map(|t| (t - started).as_secs_f64()).unwrap_or(f64::MAX),
            total,
            max_gap,
            sync_ok,
        )
    }

    // ---- Range 断点续传（模拟三星渐进式取流） ----
    // 场景：连接 1 读到第 X 字节后断开；连接 2 带 Range: bytes=X- 重连。
    // 断言：连接 2 返回 206 + Content-Range，且正文与「完整流」的第 X 字节起
    // 逐字节一致（拼接流的字节布局是确定性的）。

    /// 上游：清单 3 片，各片内容不同且大小不同（1880/940/2820 字节）。
    async fn spawn_range_upstream() -> std::net::SocketAddr {
        use tokio::io::AsyncWriteExt;
        let up = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = up.local_addr().unwrap();
        tauri::async_runtime::spawn(async move {
            loop {
                let Ok((mut sock, _)) = up.accept().await else { break };
                tauri::async_runtime::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                    let (body, ct): (&[u8], &str) = if path.contains("index.m3u8") {
                        (
                            b"#EXTM3U\n#EXTINF:5,\nseg1.ts\n#EXTINF:5,\nseg2.ts\n#EXTINF:5,\nseg3.ts\n#EXT-X-ENDLIST\n",
                            "application/vnd.apple.mpegurl",
                        )
                    } else if path.contains("seg1") {
                        (Box::leak(vec![b'A'; 1880].into_boxed_slice()), "video/mp2t")
                    } else if path.contains("seg2") {
                        (Box::leak(vec![b'B'; 940].into_boxed_slice()), "video/mp2t")
                    } else {
                        (Box::leak(vec![b'C'; 2820].into_boxed_slice()), "video/mp2t")
                    };
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        ct,
                        body.len()
                    );
                    let _ = sock.write_all(head.as_bytes()).await;
                    let _ = sock.write_all(body).await;
                    let _ = sock.flush().await;
                });
            }
        });
        addr
    }

    fn range_upstream_handle() -> Arc<Upstream> {
        Arc::new(Upstream {
            referer: None,
            user_agent: None,
            cookie: None,
            token: "rt".to_string(),
            is_samsung: false,
            ad_uris: Vec::new(),
        })
    }

    /// 读恰好 want 字节（不足则读到对端关闭，返回实际读数）。
    async fn read_exact_or_eof(sock: &mut tokio::net::TcpStream, want: usize) -> Vec<u8> {
        use tokio::io::AsyncReadExt;
        let mut out = Vec::with_capacity(want);
        let mut chunk = [0u8; 4096];
        while out.len() < want {
            let n = sock.read(&mut chunk).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            let take = n.min(want - out.len());
            out.extend_from_slice(&chunk[..take]);
            if out.len() >= want {
                break;
            }
        }
        out
    }

    #[tokio::test]
    async fn live_ts_range_resume_is_byte_exact() {
        // 完整参考流：三片拼接 = A*1880 + B*940 + C*2820 = 5640 字节
        let mut full: Vec<u8> = Vec::new();
        full.extend(std::iter::repeat(b'A').take(1880));
        full.extend(std::iter::repeat(b'B').take(940));
        full.extend(std::iter::repeat(b'C').take(2820));

        let up_addr = spawn_range_upstream().await;
        let target = format!("http://{}/index.m3u8", up_addr);
        let token = "range-token-1".to_string();
        let upstream = range_upstream_handle();

        let tv = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let tv_addr = tv.local_addr().unwrap();

        // 连接 1（无 Range）：整条读到 EOF，验证服务端全流正确
        let mut client1 = tokio::net::TcpStream::connect(tv_addr).await.unwrap();
        let (sock1, _) = tv.accept().await.unwrap();
        let server1 = tokio::spawn(serve_live_ts(
            sock1,
            token.clone(),
            target.clone(),
            upstream.clone(),
            None,
        ));
        let mut stream1: Vec<u8> = Vec::new();
        let mut chunk1 = [0u8; 8192];
        loop {
            let n = client1.read(&mut chunk1).await.unwrap_or(0);
            if n == 0 { break; }
            stream1.extend_from_slice(&chunk1[..n]);
        }
        let _ = server1.await;
        let head_end1 = stream1.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4).unwrap_or(0);
        let head1_text = String::from_utf8_lossy(&stream1[..head_end1]).to_string();
        assert!(head1_text.starts_with("HTTP/1.1 200"), "首连应 200: {}", head1_text);
        assert!(head1_text.contains("Accept-Ranges: bytes"), "应声明支持 Range");
        let body1 = &stream1[head_end1..];
        assert_eq!(body1, &full[..], "首连全流应与参考流逐字节一致");

        // 连接 2（Range: bytes=2000- 续传）：206 + Content-Range，正文与完整流第 2000 字节起逐字节一致
        let mut client2 = tokio::net::TcpStream::connect(tv_addr).await.unwrap();
        let (sock2, _) = tv.accept().await.unwrap();
        let server2 = tokio::spawn(serve_live_ts(
            sock2,
            token.clone(),
            target.clone(),
            upstream.clone(),
            Some("bytes=2000-".to_string()),
        ));
        let mut stream2: Vec<u8> = Vec::new();
        let mut chunk2 = [0u8; 8192];
        loop {
            let n = client2.read(&mut chunk2).await.unwrap_or(0);
            if n == 0 { break; }
            stream2.extend_from_slice(&chunk2[..n]);
        }
        let _ = server2.await;
        let head_end2 = stream2.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4).unwrap_or(0);
        let head2_text = String::from_utf8_lossy(&stream2[..head_end2]).to_string();
        assert!(
            head2_text.starts_with("HTTP/1.1 206"),
            "续传应 206: {}",
            head2_text
        );
        assert!(
            head2_text.contains("Content-Range: bytes 2000-/*"),
            "应带 Content-Range: {}",
            head2_text
        );
        let body2 = &stream2[head_end2..];
        assert_eq!(body2, &full[2000..], "续传内容应与完整流逐字节一致");

        // 连接 3（无 Range）：状态重置，从头全新下发
        let mut client3 = tokio::net::TcpStream::connect(tv_addr).await.unwrap();
        let (sock3, _) = tv.accept().await.unwrap();
        let server3 = tokio::spawn(serve_live_ts(
            sock3,
            token.clone(),
            target.clone(),
            upstream,
            None,
        ));
        let mut stream3: Vec<u8> = Vec::new();
        let mut chunk3 = [0u8; 8192];
        loop {
            let n = client3.read(&mut chunk3).await.unwrap_or(0);
            if n == 0 { break; }
            stream3.extend_from_slice(&chunk3[..n]);
        }
        let _ = server3.await;
        let body3 = &stream3[stream3.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4).unwrap_or(0)..];
        assert_eq!(body3, &full[..], "无 Range 重连应从头完整下发");
    }

    /// 源码级守卫：生产代码里不允许出现「孤儿 #[cfg(test)]」（后面跟的不是 println）。
    /// 背景：清理调试探针时两次留下孤儿属性——release 构建把属性附着的下一条
    /// 语句整个剥除：一次剥掉了 let mut buffer（v1.5.1 CI 双端编译失败），
    /// 一次剥掉了代理 accept 循环的 spawn（v1.5.2 代理全盲，电视 716）。
    /// 这类错误 debug/test 构建全绿、编译也不报错，只有源码审查能拦住。
    #[test]
    fn no_dangling_cfg_test_attributes() {
        let manifest = env!("CARGO_MANIFEST_DIR");
        let src = std::fs::read_to_string(format!("{}/src/dlna.rs", manifest))
            .expect("读取 dlna.rs");
        let lines: Vec<&str> = src.lines().collect();
        // 测试模块（mod tests / mod cast_e2e）内部合法，不受限
        let tests_start = lines
            .iter()
            .position(|l| l.contains("mod tests {"))
            .expect("找不到测试模块");
        let mut problems = Vec::new();
        for i in 0..tests_start {
            if lines[i].trim() == "#[cfg(test)]" {
                let next = lines.get(i + 1).map(|l| l.trim()).unwrap_or("");
                // 合法形态：调试 println、mod 声明、与 #[cfg(not(test))] 的成对函数变体
                let prev_pair = i > 0 && lines[i - 1].contains("cfg(not(test))");
                let allowed = next.starts_with("println!")
                    || next.starts_with("mod ")
                    || next.starts_with('{')  // cfg 块：属性只作用于花括号内部，安全
                    || prev_pair;
                if !allowed {
                    problems.push(format!("行 {}: #[cfg(test)] 后跟的是「{}」", i + 1, next));
                }
            }
        }
        assert!(
            problems.is_empty(),
            "生产代码存在孤儿 #[cfg(test)]（release 会剥除其下一条语句）:\n{}",
            problems.join("\n")
        );
    }

    /// 守卫：start_stream_proxy 的 accept 循环必须真的在工作——
    /// 连接代理端口并确认收到响应（v1.5.2 的孤儿属性把 accept 循环整个
    /// 剥除后编译照常通过，代理变成「监听但从不接受」的死端口，电视全部 716）。
    #[tokio::test]
    async fn proxy_accept_loop_actually_accepts() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        // 上游：返回固定清单
        let up = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let up_addr = up.local_addr().unwrap();
        tauri::async_runtime::spawn(async move {
            loop {
                let Ok((mut sock, _)) = up.accept().await else { break };
                tauri::async_runtime::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let (body, ct): (&[u8], &str) = if req.contains(".m3u8") {
                        (
                            b"#EXTM3U\n#EXTINF:5,\nseg1.ts\n#EXT-X-ENDLIST\n",
                            "application/vnd.apple.mpegurl",
                        )
                    } else {
                        (b"SEG", "video/mp2t")
                    };
                    let head = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        ct,
                        body.len()
                    );
                    let _ = sock.write_all(head.as_bytes()).await;
                    let _ = sock.write_all(body).await;
                    let _ = sock.flush().await;
                });
            }
        });

        let target = format!("http://{}/index.m3u8", up_addr);
        let token = "accept-guard".to_string();
        let upstream = Arc::new(Upstream {
            referer: None,
            user_agent: None,
            cookie: None,
            token: token.clone(),
            is_samsung: false,
            ad_uris: Vec::new(),
        });
        // preferred_ip 127.0.0.1：测试内连接走回环
        let (entry, _ts_entry) = start_stream_proxy(
            target,
            token,
            None,
            None,
            None,
            Some(std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)),
            false,
            Vec::new(),
        )
        .await
        .expect("start_stream_proxy 应成功");

        // 连接代理端口并读响应：accept 循环若被剥除，这里会超时
        let (host, port, path) = parse_http_url(&entry).expect("entry 应可解析");
        let mut sock = tokio::time::timeout(
            Duration::from_secs(5),
            tokio::net::TcpStream::connect((host.as_str(), port)),
        )
        .await
        .expect("连接代理超时（accept 循环未工作？）")
        .expect("连接失败");
        let req = format!(
            "GET {} HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
            path,
            host_header(&host, port)
        );
        sock.write_all(req.as_bytes()).await.unwrap();
        let mut resp = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = tokio::time::timeout(Duration::from_secs(5), sock.read(&mut chunk))
                .await
                .expect("读响应超时")
                .unwrap_or(0);
            if n == 0 {
                break;
            }
            resp.extend_from_slice(&chunk[..n]);
        }
        let text = String::from_utf8_lossy(&resp);
        assert!(
            text.starts_with("HTTP/1.1 200"),
            "代理应返回清单: {}",
            text.chars().take(120).collect::<String>()
        );
        assert!(text.contains("#EXTM3U"), "代理应转发上游清单内容");
    }

    #[test]
    fn parse_range_start_variants() {
        assert_eq!(parse_range_start(&Some("bytes=0-".to_string())), None, "bytes=0- 视为全新下发");
        assert_eq!(parse_range_start(&Some("bytes=12345-".to_string())), Some(12345));
        assert_eq!(parse_range_start(&Some("bytes=100-200".to_string())), Some(100));
        assert_eq!(parse_range_start(&Some("bytes=-500".to_string())), None, "后缀 Range 无法映射，忽略");
        assert_eq!(parse_range_start(&Some("bytes=abc-".to_string())), None);
        assert_eq!(parse_range_start(&None), None);
        assert_eq!(parse_range_start(&Some("bytes=".to_string())), None);
    }
}
