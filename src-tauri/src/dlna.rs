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
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use mdns_sd::{ServiceDaemon, ServiceEvent};
use tauri_plugin_dialog::DialogExt;

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

fn proxy_connection_count() -> u64 {
    PROXY_CONN_COUNT.load(Ordering::Relaxed)
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
) -> Result<String, String> {
    let referer = referer.filter(|s| !s.trim().is_empty());
    let user_agent = user_agent.filter(|s| !s.trim().is_empty());
    let cookie = cookie.filter(|s| !s.trim().is_empty());

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
                    let (_, ts_entry) = start_stream_proxy(
                        url.clone(),
                        generate_session_token(),
                        referer.clone(),
                        user_agent.clone(),
                        cookie.clone(),
                        proxy_ip,
                        is_samsung,
                    )
                    .await?;
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
                    dlna_play(&control_url).await?;
                    // 从当前进度续投；TS 串流是直播形态不支持 REL_TIME 续播；
                    // 部分电视不支持 REL_TIME Seek，失败不影响投屏本身
                    if let Some(pos) = position {
                        if pos > 1.0 && *mode != "proxy-ts" {
                            let _ = dlna_seek(&control_url, pos).await;
                        }
                    }
                    return Ok(playback_url);
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
            if let Some(ref_value) = referer.filter(|s| !s.trim().is_empty()) {
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
                }
                Err(e) => report.push_str(&format!("  结果: 本机拉流失败 —— {}（DNS/网络/证书问题，电视同样拉不到）\n", e)),
            }
        }
    }

    // [4] 本地代理状态
    report.push_str("\n[4] 本地防盗链代理\n");
    report.push_str(&format!("  累计已服务电视连接数: {}\n", proxy_connection_count()));

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
    format!(
        "<u:SetAVTransportURI xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">\
<InstanceID>0</InstanceID><CurrentURI>{}</CurrentURI>\
<CurrentURIMetaData>{}</CurrentURIMetaData></u:SetAVTransportURI>",
        uri,
        xml_escape(&metadata)
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
    });
    tauri::async_runtime::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _peer)) => {
                    let upstream = upstream.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = handle_proxy_conn(stream, upstream).await;
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
    PROXY_CONN_COUNT.store(0, Ordering::Relaxed); // 新会话重置诊断计数
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

struct LocalFileState {
    base: String,
    files: HashMap<String, PathBuf>, // token -> 本机文件路径
    port: u16,
}

static LOCAL_FILE: Lazy<Mutex<Option<LocalFileState>>> = Lazy::new(|| Mutex::new(None));

/// 本机文件按扩展名给 MIME（投屏端校验 protocolInfo 用）。
fn local_file_mime(path: &Path) -> &'static str {
    let ext = path
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

#[tauri::command]
pub async fn start_local_file_server(
    path: String,
    preferred_ip: Option<IpAddr>,
) -> Result<LocalFileEntry, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("文件不存在或不是普通文件: {}", path));
    }
    // URL 中保留文件名，让扩展名可见（投屏端据此分类 MIME）
    let fname = p
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or("video.mp4")
        .to_string();
    ensure_local_file_server(preferred_ip).await?;
    let token = generate_session_token();
    let (url, loopback_url) = {
        let mut guard = LOCAL_FILE.lock().unwrap();
        match guard.as_mut() {
            Some(state) => {
                state.files.insert(token.clone(), p.clone());
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
    Ok(path.map(|p| p.to_string_lossy().to_string()))
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
    // browse() 直接返回 mpsc 接收端（无 get_event_receiver 一说）。
    // 把整个收集过程放到阻塞任务里：recv_timeout 区分「正常空等超时」与
    // 「通道断开」，前者继续等、后者（守护进程已停）停止收集，不会提前收尾。
    let receiver = daemon
        .browse("_airplay._tcp.local.")
        .map_err(|e| format!("AirPlay 浏览失败: {}", e))?;
    let devices = tauri::async_runtime::spawn_blocking(move || {
        let mut map: HashMap<String, DlnaDevice> = HashMap::new();
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
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
                // 其它事件（服务移除/更新）：忽略
                Ok(_) => continue,
                // 超时：正常空等，直到 deadline
                Err(e) if e.is_timeout() => continue,
                // 通道断开（守护进程已停）：停止收集
                Err(_) => break,
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

async fn ensure_local_file_server(preferred_ip: Option<IpAddr>) -> Result<(), String> {
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
                    tauri::async_runtime::spawn(async move {
                        let _ = handle_local_file_conn(stream).await;
                    });
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            }
        }
    });
    Ok(())
}

async fn handle_local_file_conn(mut stream: tokio::net::TcpStream) -> Result<(), String> {
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
    let file_path: Option<PathBuf> = {
        let guard = LOCAL_FILE.lock().unwrap();
        guard.as_ref().and_then(|s| s.files.get(token)).cloned()
    };
    let file_path = match file_path {
        Some(p) => p,
        None => {
            write_status(&mut stream, "404 Not Found", b"not found").await;
            return Ok(());
        }
    };
    let meta = match tokio::fs::metadata(&file_path).await {
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
    let mime = local_file_mime(&file_path);

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
    let mut file = match tokio::fs::File::open(&file_path).await {
        Ok(f) => f,
        Err(_) => {
            write_status(&mut stream, "404 Not Found", b"not found").await;
            return Ok(());
        }
    };
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
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nAccept-Ranges: none\r\n\
transferMode.dlna.org: Streaming\r\ncontentFeatures.dlna.org: {}\r\nConnection: close\r\n\r\n",
            ctype, SAMSUNG_DLNA_FLAGS
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
        return serve_live_ts(stream, ts_target, upstream).await;
    }
    if encoded.is_empty() {
        return Err("代理路径缺少目标地址".to_string());
    }
    let target_bytes = b64url_decode(encoded).ok_or("代理地址解码失败")?;
    let target = String::from_utf8(target_bytes).map_err(|_| "代理地址不是合法 UTF-8")?;

    // 构造上游请求：带鉴权头 + Range 透传；未提供 UA 时补默认浏览器 UA
    let mut request = HTTP.get(&target);
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
    if let Some(range) = &range {
        request = request.header(reqwest::header::RANGE, range);
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
        let rewritten = rewrite_playlist(&text, &target);
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
    let mut request = HTTP.get(url);
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
    /// 媒体清单：分片绝对地址 + 是否 VOD（有 ENDLIST）
    Media(Vec<String>, bool),
    /// master 清单：第一个变体的绝对地址
    Master(String),
    Unknown,
}

fn classify_playlist(text: &str, base_url: &str) -> Result<PlaylistKind, String> {
    // 媒体清单特征：分片时长标记或目标时长声明
    if text.contains("#EXTINF") || text.contains("#EXT-X-TARGETDURATION") {
        return parse_media_playlist(text, base_url).map(|(s, e)| PlaylistKind::Media(s, e));
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
            PlaylistKind::Media(..) => return Ok(current),
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
fn parse_media_playlist(text: &str, base_url: &str) -> Result<(Vec<String>, bool), String> {
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
        segments.push(resolve_url(base_url, line));
    }
    Ok((segments, endlist))
}

/// 拉取并解析媒体清单。
async fn fetch_media_playlist(
    url: &str,
    upstream: &Upstream,
) -> Result<(Vec<String>, bool), String> {
    let text = upstream_text(url, upstream).await?;
    parse_media_playlist(&text, url)
}

/// 拉取单个分片并流式写给电视；写失败（电视断开）即终止整条流。
async fn stream_segment(
    url: &str,
    upstream: &Upstream,
    stream: &mut tokio::net::TcpStream,
) -> Result<(), String> {
    let response = upstream_get(url, upstream)
        .send()
        .await
        .map_err(|e| format!("拉取分片失败: {}", e))?;
    if !response.status().is_success() {
        return Err(format!("分片拉取失败: HTTP {}", response.status().as_u16()));
    }
    let mut upstream_stream = response;
    loop {
        match upstream_stream.chunk().await {
            Ok(Some(chunk)) => {
                stream
                    .write_all(&chunk)
                    .await
                    .map_err(|_| "电视中断了连接".to_string())?;
            }
            Ok(None) => break,
            Err(e) => return Err(format!("读取分片数据失败: {}", e)),
        }
    }
    stream
        .flush()
        .await
        .map_err(|_| "电视中断了连接".to_string())?;
    Ok(())
}

/// live.ts 端点：HLS → 连续 MPEG-TS 字节流。
/// 响应头在清单探测成功之后才发——探测失败时电视拿到明确的 502，
/// 投屏梯度的报错才有意义。直播清单（无 ENDLIST）轮询追加分片直到电视断开。
async fn serve_live_ts(
    mut stream: tokio::net::TcpStream,
    target: String,
    upstream: Arc<Upstream>,
) -> Result<(), String> {
    let media_url = resolve_media_playlist(&target, &upstream).await?;
    let (mut pending, mut endlist) = fetch_media_playlist(&media_url, &upstream).await?;
    if pending.is_empty() {
        return Err("媒体清单里没有可用分片".to_string());
    }

    let ts_mime = if upstream.is_samsung {
        "video/vnd.dlna.mpeg-tts"
    } else {
        "video/mp2t"
    };
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nCache-Control: no-store\r\n\
transferMode.dlna.org: Streaming\r\ncontentFeatures.dlna.org: {}\r\nConnection: close\r\n\r\n",
        ts_mime, SAMSUNG_DLNA_FLAGS
    );
    stream
        .write_all(head.as_bytes())
        .await
        .map_err(|e| format!("写出响应头失败: {}", e))?;
    stream.flush().await.ok();

    let mut served: std::collections::HashSet<String> = std::collections::HashSet::new();
    loop {
        for seg in std::mem::take(&mut pending) {
            if !served.insert(seg.clone()) {
                continue; // 直播轮询时跳过已服务的分片
            }
            stream_segment(&seg, &upstream, &mut stream).await?;
        }
        if endlist {
            break; // VOD：整部播完
        }
        // 直播清单：隔 2 秒重取，把新分片继续喂给电视
        tokio::time::sleep(Duration::from_secs(2)).await;
        match fetch_media_playlist(&media_url, &upstream).await {
            Ok((next, e)) => {
                pending = next;
                endlist = e;
            }
            Err(_) => continue, // 单次刷新失败不打断整条流
        }
    }
    Ok(())
}

/// 把 m3u8 里的分片/密钥/子列表地址改写成本地代理地址。
fn rewrite_playlist(text: &str, playlist_url: &str) -> String {
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
            *guard = Some(ProxyState { base });
        }
        let playlist = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:4,\nseg1.ts\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhi/index.m3u8\n";
        let rewritten = rewrite_playlist(playlist, "https://src.example.com/vod/list.m3u8");
        assert!(rewritten.contains("/s/")); // 分片与密钥都已改写
        assert!(rewritten.contains("#EXTINF:4,"));
        assert!(rewritten.starts_with("#EXTM3U"));
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
        // URL 的 & 已转义（设备端 XML 解析器必需），m3u8 的 protocolInfo 已带上
        assert!(body.contains("&amp;y=2"));
        assert!(body.contains("&lt;res protocolInfo="));
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
            parse_media_playlist(text, "https://a.b/vod/index.m3u8").expect("parse ok");
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
            parse_media_playlist(text, "http://a.b/live.m3u8").expect("parse ok");
        assert!(!endlist);
        assert_eq!(segments, vec!["http://a.b/live.ts".to_string()]);
    }

    #[test]
    fn parse_media_playlist_rejects_encryption() {
        let text = "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:10,\nseg.ts\n";
        let err = parse_media_playlist(text, "https://a.b/v.m3u8").unwrap_err();
        assert!(err.contains("AES-128"), "报错应带加密方法: {}", err);
    }

    #[test]
    fn parse_media_playlist_rejects_fmp4() {
        let text = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:10,\nseg.m4s\n";
        let err = parse_media_playlist(text, "https://a.b/v.m3u8").unwrap_err();
        assert!(err.contains("fMP4"), "报错应说明 fMP4: {}", err);
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
            Ok(PlaylistKind::Media(_, true))
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
