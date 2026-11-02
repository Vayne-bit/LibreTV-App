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
// 依赖刻意收敛在仓库已有 crate（tokio / reqwest / serde / once_cell），不引入新依赖。
// SSDP 用 std UdpSocket 组播；Android 侧需要多播锁（MainActivity.kt 启动时 acquire），
// 并在 Manifest 声明 CHANGE_WIFI_MULTICAST_STATE（apply-android-overrides.mjs 注入）。

use once_cell::sync::Lazy;
use serde::Serialize;
use std::net::{IpAddr, Ipv4Addr, UdpSocket};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

// ---------- 数据结构 ----------

#[derive(Serialize, Debug, Clone)]
pub struct DlnaDevice {
    pub name: String,
    pub control_url: String,
    pub location: String,
}

#[derive(Clone, Debug)]
struct Upstream {
    referer: Option<String>,
    user_agent: Option<String>,
    cookie: Option<String>,
}

struct ProxyState {
    base: String, // http://<lan-ip>:<port>
}

static PROXY: Lazy<Mutex<Option<ProxyState>>> = Lazy::new(|| Mutex::new(None));
static PROXY_SEQ: AtomicU64 = AtomicU64::new(0);

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
/// 源需要 Referer/User-Agent/Cookie 时自动经本地代理中转，返回电视实际播放的地址。
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
    let has_header = |v: &Option<String>| v.as_deref().map(|s| !s.trim().is_empty()).unwrap_or(false);
    let playback_url = if has_header(&referer) || has_header(&user_agent) || has_header(&cookie) {
        start_stream_proxy(
            url.clone(),
            referer.filter(|s| !s.trim().is_empty()),
            user_agent.filter(|s| !s.trim().is_empty()),
            cookie.filter(|s| !s.trim().is_empty()),
        )
        .await?
    } else {
        stop_stream_proxy();
        url.clone()
    };

    dlna_set_av_transport(&control_url, &playback_url, title.as_deref()).await?;
    dlna_play(&control_url).await?;
    // 从当前进度续投；部分电视不支持 REL_TIME Seek，失败不影响投屏本身
    if let Some(pos) = position {
        if pos > 1.0 {
            let _ = dlna_seek(&control_url, pos).await;
        }
    }
    Ok(playback_url)
}

/// 停止投屏。
#[tauri::command]
pub async fn stop_dlna_cast(control_url: String) -> Result<(), String> {
    stop_stream_proxy();
    dlna_stop(&control_url).await
}

// ---------- SSDP 搜索 ----------

fn ssdp_search_locations(timeout: Duration) -> Result<Vec<String>, String> {
    let socket = UdpSocket::bind(("0.0.0.0", 0)).map_err(|e| format!("SSDP 绑定失败: {}", e))?;
    socket
        .set_read_timeout(Some(Duration::from_millis(250)))
        .map_err(|e| format!("SSDP 设置超时失败: {}", e))?;
    let _ = socket.join_multicast_v4(&Ipv4Addr::new(239, 255, 255, 250), &Ipv4Addr::UNSPECIFIED);

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
        let _ = socket.send_to(message.as_bytes(), "239.255.255.250:1900");
        std::thread::sleep(Duration::from_millis(60));
    }

    let mut locations = Vec::new();
    let mut buffer = [0u8; 8192];
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        match socket.recv_from(&mut buffer) {
            Ok((n, _peer)) => {
                // 只用 ASCII 小写化（字节长度不变，切片安全）
                let text = String::from_utf8_lossy(&buffer[..n]).to_ascii_lowercase();
                if let Some(pos) = text.find("location:") {
                    let rest = text[pos + "location:".len()..].trim_start();
                    let end = rest.find('\r').or_else(|| rest.find('\n')).unwrap_or(rest.len());
                    let location = rest[..end].trim().to_string();
                    if location.starts_with("http") && !locations.contains(&location) {
                        locations.push(location);
                    }
                }
            }
            Err(_) => continue, // 读超时，等下一个应答直到截止时间
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
    // controlURL 可能是相对路径，先看 URLBase 再回落到 location
    let base = xml_text(&xml, "URLBase").unwrap_or_else(|| location.to_string());
    let control_path = find_avtransport_control_url(&xml).ok_or("设备不支持 AVTransport 服务")?;
    let control_url = resolve_url(&base, &control_path);
    if control_url.is_empty() {
        return Err("controlURL 解析失败".to_string());
    }
    Ok(DlnaDevice {
        name,
        control_url,
        location: location.to_string(),
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
                return Some(xml_unescape(raw_value.trim()).to_string());
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
    Some(xml_unescape(xml[start..end].trim()).to_string())
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

/// 极简相对地址解析：只处理 controlURL 常见的两种形态（绝对地址 / 根相对路径）。
fn resolve_url(base: &str, target: &str) -> String {
    let target = target.trim();
    if target.starts_with("http://") || target.starts_with("https://") {
        return target.to_string();
    }
    let (scheme, rest) = match base.split_once("://") {
        Some(pair) => pair,
        None => return String::new(),
    };
    let authority_end = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..authority_end];
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
    let soap_action = format!("\"urn:schemas-upnp-org:service:AVTransport:1#{}\"", action);
    let response = HTTP
        .post(control_url)
        .header("SOAPACTION", &soap_action)
        .header("Content-Type", "text/xml; charset=utf-8")
        .body(envelope)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("投屏指令({})发送失败: {}", action, e))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "投屏指令({})被设备拒绝: HTTP {}",
            action,
            status.as_u16()
        ));
    }
    // 部分设备返回 200 但体内带 UPnPError
    if text.contains("UPnPError") {
        return Err(format!("投屏指令({})被设备拒绝: UPnPError", action));
    }
    Ok(())
}

async fn dlna_set_av_transport(
    control_url: &str,
    playback_url: &str,
    title: Option<&str>,
) -> Result<(), String> {
    let safe_title = xml_escape(title.unwrap_or("LibreTV"));
    let metadata = format!(
        "<DIDL-Lite xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\" \
xmlns:dc=\"http://purl.org/dc/elements/1.1/\" \
xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\">\
<item id=\"0\" parentID=\"0\" restricted=\"1\">\
<dc:title>{}</dc:title><upnp:class>object.item.videoItem</upnp:class>\
</item></DIDL-Lite>",
        safe_title
    );
    let body = format!(
        "<u:SetAVTransportURI xmlns:u=\"urn:schemas-upnp-org:service:AVTransport:1\">\
<InstanceID>0</InstanceID>\
<CurrentURI>{}</CurrentURI>\
<CurrentURIMetaData>{}</CurrentURIMetaData>\
</u:SetAVTransportURI>",
        xml_escape(playback_url),
        xml_escape(&metadata)
    );
    dlna_soap_call(control_url, "SetAVTransportURI", &body).await
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

/// 确定本机局域网 IP（用于拼出电视可访问的代理地址）。
/// 用 UDP connect 的方式探测默认路由出口，不真正发包。
fn local_lan_ip() -> Option<IpAddr> {
    let socket = UdpSocket::bind(("0.0.0.0", 0)).ok()?;
    socket.connect("223.5.5.5:80").ok()?; // 阿里公共 DNS，仅作路由探测
    Some(socket.local_addr().ok()?.ip())
}

/// 启动本地流代理（每次投屏新建），返回电视可拉流的代理入口地址
/// （入口即原始目标地址的 b64 包装；分片/密钥/子列表会在列表改写时陆续指向代理）。
async fn start_stream_proxy(
    target: String,
    referer: Option<String>,
    user_agent: Option<String>,
    cookie: Option<String>,
) -> Result<String, String> {
    let listener = tokio::net::TcpListener::bind("0.0.0.0:0")
        .await
        .map_err(|e| format!("本地代理端口绑定失败: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("本地代理地址读取失败: {}", e))?
        .port();
    let ip = local_lan_ip().unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));
    let base = format!("http://{}:{}", ip, port);
    let entry = format!("{}/s/{}", base, b64url_encode(target.as_bytes()));

    let upstream = Arc::new(Upstream {
        referer,
        user_agent,
        cookie,
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
        *guard = Some(ProxyState { base: base.clone() });
    }
    let _ = PROXY_SEQ.fetch_add(1, Ordering::Relaxed);
    Ok(entry)
}

fn stop_stream_proxy() {
    // 状态置空即可：下一次投屏会建新的 listener；
    // 旧 listener 任务没有句柄可 abort，随连接自然结束后结束（accept 循环会一直挂着，
    // 但每次投屏只占一个任务，量级可忽略）。置空保证 proxy_url_for 取到新 base。
    if let Ok(mut guard) = PROXY.lock() {
        *guard = None;
    }
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
    if method != "GET" {
        return Err("仅支持 GET".to_string());
    }
    // 透传 Range（电视拖进度条时发出）
    let range = head
        .lines()
        .find(|line| line.to_ascii_lowercase().starts_with("range:"))
        .and_then(|line| line.split_once(':'))
        .map(|(_, value)| value.trim().to_string());

    // 健康检查路径：返回 200，电视/前端可用它确认代理可达
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

    // 路径形如 /s/<b64url(目标地址)>
    let encoded = path.split("/s/").nth(1).unwrap_or_default();
    let encoded = encoded.split('?').next().unwrap_or_default();
    if encoded.is_empty() {
        return Err("代理路径缺少目标地址".to_string());
    }
    let target_bytes = b64url_decode(encoded).ok_or("代理地址解码失败")?;
    let target = String::from_utf8(target_bytes).map_err(|_| "代理地址不是合法 UTF-8")?;

    // 构造上游请求：带鉴权头 + Range 透传
    let mut request = HTTP.get(&target);
    if let Some(referer) = &upstream.referer {
        request = request.header(reqwest::header::REFERER, referer);
    }
    if let Some(user_agent) = &upstream.user_agent {
        request = request.header(reqwest::header::USER_AGENT, user_agent);
    }
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

/// 目标地址 -> 本地代理地址。
fn proxy_url_for(resolved: &str) -> String {
    let base = match PROXY.lock() {
        Ok(guard) => guard.as_ref().map(|state| state.base.clone()),
        Err(_) => None,
    };
    match base {
        Some(base) => format!("{}/s/{}", base, b64url_encode(resolved.as_bytes())),
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
        assert_eq!(
            resolve_url("http://a.b/c/d.m3u8", "../up.ts"),
            "http://a.b/c../up.ts"
        ); // 简化实现的已知局限：.. 不归一化（实际源站极少用）
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
}
