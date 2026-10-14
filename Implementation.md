# Tauri 移动端应用实现文档 for LibreTV

## 目录
1. 环境准备与 Tauri 项目初始化
2. 集成现有 Web 前端资源
3. 核心代理逻辑迁移至 Rust
4. 定义 Tauri 命令 (Commands)
5. 实现 HTTP 请求与内容获取
6. 实现 M3U8 内容判断与解析
7. 实现 M3U8 内容处理 (URL 重写)
8. 前端 JavaScript 修改
9. 修改 js/api.js 以调用 Rust 命令
10. 处理 player.html 中的视频流 URL
11. M3U8 片段和密钥的获取策略
    - 方案 A: 通过 Rust 命令中转获取
    - 方案 B: (推荐) 使用 Tauri 自定义协议
12. 配置与环境变量处理
13. 本地存储 (localStorage)
14. 构建与打包移动应用
15. 分步实现计划
16. 潜在挑战与调试技巧

1. 环境准备与 Tauri 项目初始化

在开始之前，请确保你已经按照 Tauri 官方文档 设置好了 Rust 和特定平台的移动开发环境 (Android SDK/NDK, Xcode)。

步骤:

创建新的 Tauri 项目:

```bash
cargo install tauri-cli --version "^1" # 如果尚未安装或需要特定版本
cargo tauri init
```


在初始化过程中，Tauri CLI 会询问你的应用名称、窗口标题等。对于前端开发服务器 URL，你可以暂时留空或指向一个占位符，因为我们将直接集成静态文件。选择 "Vanilla" (HTML, CSS, JS) 或者你熟悉的前端框架（如果未来打算重构部分UI）。

配置 tauri.conf.json:

修改 build.distDir 指向你现有 LibreTV 项目的根目录（或者你打算存放构建后 Web 资源的地方）。例如，如果你的 LibreTV Web 文件在 ../LibreTV-Web，则设置为 "../LibreTV-Web"。
确保 build.devPath 也指向你的 index.html 所在的开发服务器地址（如果使用开发服务器的话），或者直接指向 index.html 文件路径。为了简单起见，我们将直接使用 distDir。
在 tauri.allowlist 中，确保启用了必要的功能，例如：
http.all 或 http.request: 允许 Rust 发起 HTTP 请求。
shell.open: 如果需要打开外部链接。
fs.all: 如果需要读写文件（例如配置文件）。
protocol.asset: 允许加载应用内的静态资源。
protocol.all 或 customProtocol: 如果你选择使用自定义协议方案。
window.all: 控制窗口行为。
event.all: 用于事件通信。
为移动端配置添加 tauri-plugin-deep-link 或类似的插件来处理自定义 URL Scheme（如果采用方案B）。
初始化移动端项目:

cargo tauri android init
cargo tauri ios init


2. 集成现有 Web 前端资源

复制 Web 文件: 将 LibreTV 项目中所有的 HTML, CSS, JS 文件 (index.html, player.html, css/, js/ 等) 复制到 Tauri 项目中 tauri.conf.json 里 build.distDir 指定的目录。

修改 index.html:

移除对外部 CDN 脚本的依赖（如 Tailwind CSS），考虑将其下载到本地并通过相对路径引入，或者在 Tauri 构建时处理。不过，对于快速原型，CDN 也可以暂时保留，但要注意网络问题。
Tauri 应用会自动加载 distDir 下的 index.html。
初步运行检查:

```bash
cargo tauri dev # 在桌面端测试
cargo tauri android dev # 在 Android 模拟器/设备上测试
cargo tauri ios dev   # 在 iOS 模拟器/设备上测试
```


此时，你的 Web UI 应该能在 Tauri 窗口或移动设备上显示出来，但所有依赖 /proxy/ 的功能都会失效。

3. 核心代理逻辑迁移至 Rust

这是最关键的一步。我们需要将 api/proxy/[...path].mjs (或 functions/proxy/[[path]].js) 中的 JavaScript 代理逻辑用 Rust 实现。

文件结构: 在 src-tauri/src/main.rs (或创建新的模块如 src-tauri/src/proxy_handler.rs) 中编写 Rust 代码。

3.1. 定义 Tauri 命令 (Commands)
Tauri 命令是前端 JavaScript 可以调用的 Rust 函数。
```

// src-tauri/src/main.rs (或 proxy_handler.rs)
```
use tauri::State;
use std::sync::Mutex; // 如果需要共享状态

// 定义可能需要的状态，例如 User-Agent 列表
struct AppState {
    user_agents: Mutex<Vec<String>>,
    // 可以添加 HttpClient 实例以复用连接
    // http_client: reqwest::Client,
}

impl AppState {
    fn new() -> Self {
        // 从 js/config.js 或环境变量初始化 USER_AGENTS
        let default_user_agents = vec![
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36".to_string(),
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15".to_string(),
        ];
        // TODO: 尝试从配置或环境变量加载 USER_AGENTS_JSON
        AppState {
            user_agents: Mutex::new(default_user_agents),
            // http_client: reqwest::Client::new(),
        }
    }
    fn get_random_user_agent(&self) -> String {
        let agents = self.user_agents.lock().unwrap();
        if agents.is_empty() {
            return "Tauri/1.0".to_string(); // Fallback
        }
        use rand::seq::SliceRandom;
        let mut rng = rand::thread_rng();
        agents.choose(&mut rng).unwrap_or(&"Tauri/1.0".to_string()).clone()
    }
}


#[derive(serde::Serialize, serde::Deserialize)]
struct FetchResult {
    content: String,
    content_type: String,
    // response_headers: std::collections::HashMap<String, String>, // 可选
}

#[derive(serde::Serialize, serde::Deserialize)]
struct ErrorResult {
    error: String,
}

// 主代理处理命令
#[tauri::command]
async fn proxy_fetch_content(
    target_url: String,
    // original_request_headers: Option<std::collections::HashMap<String, String>>, // JS可以传递原始请求头
    app_state: State<'_, AppState>,
) -> Result<FetchResult, ErrorResult> {
    println!("[Rust Proxy] Requesting URL: {}", target_url);

    // 1. 解码 target_url (如果JS传来的是编码后的)
    // let decoded_url = urlencoding::decode(&target_url).map_err(|e| ErrorResult { error: e.to_string() })?.into_owned();
    // 假设JS直接传递解码后的URL，因为JS本身就有decodeURIComponent
    let decoded_url = target_url;

    // 2. 获取内容
    let fetch_response = fetch_content_with_type_rs(&decoded_url, &app_state).await;
    match fetch_response {
        Ok(mut raw_content_data) => {
            // 3. 判断是否是 M3U8
            if is_m3u8_content_rs(&raw_content_data.content, &raw_content_data.content_type) {
                println!("[Rust Proxy] M3U8 detected for: {}", decoded_url);
                match process_m3u8_content_rs(&decoded_url, raw_content_data.content, 0, &app_state).await {
                    Ok(processed_m3u8) => {
                        raw_content_data.content = processed_m3u8;
                        raw_content_data.content_type = "application/vnd.apple.mpegurl;charset=utf-8".to_string();
                        Ok(raw_content_data)
                    }
                    Err(e) => Err(ErrorResult { error: format!("M3U8 processing error: {}", e) }),
                }
            } else {
                println!("[Rust Proxy] Non-M3U8 content for: {}", decoded_url);
                Ok(raw_content_data)
            }
        }
        Err(e) => Err(e),
    }
}

// 用于获取M3U8片段或密钥的命令 (如果采用方案A)
#[tauri::command]
async fn fetch_resource_segment(
    target_url: String, // 应该是原始的、未代理的URL
    app_state: State<'_, AppState>,
) -> Result<Vec<u8>, String> { // 直接返回原始字节流
    println!("[Rust Proxy Segment] Requesting: {}", target_url);
    let client = reqwest::Client::new();
    let user_agent = app_state.get_random_user_agent();
    let referer = get_base_url_rs(&target_url).unwrap_or_else(|_| target_url.clone());


    match client
        .get(&target_url)
        .header(reqwest::header::USER_AGENT, user_agent)
        .header(reqwest::header::REFERER, referer)
        .header(reqwest::header::ACCEPT, "*/*")
        .send()
        .await
    {
        Ok(response) => {
            if response.status().is_success() {
                response.bytes().await.map_err(|e| e.to_string())
            } else {
                Err(format!("HTTP error {}: {}", response.status(), response.text().await.unwrap_or_default()))
            }
        }
        Err(e) => Err(e.to_string()),
    }
}


// 在 main 函数中注册命令和状态
fn main() {
    let app_state = AppState::new();
    tauri::Builder::default()
        .manage(app_state) // 注册状态
        .invoke_handler(tauri::generate_handler![
            proxy_fetch_content,
            fetch_resource_segment // 如果使用方案A
        ])
        // 如果使用自定义协议 (方案B)，在这里注册
        .register_uri_scheme_protocol("app-media", move |app, request| {
            // ... 实现自定义协议的逻辑 ...
            // 详见 5.2 节
            let path = request.uri().replace("app-media://", "");
            let decoded_url = urlencoding::decode(&path).unwrap_or_default().into_owned();
            println!("[Custom Protocol] app-media request for: {}", decoded_url);

            // 需要一个运行时来执行异步代码
            let handle = app.handle();
            let fut = async move {
                let app_state_instance = handle.state::<AppState>();
                let client = reqwest::Client::new(); // 或者从 AppState 获取共享的 client
                let user_agent = app_state_instance.get_random_user_agent();
                let referer_base = get_base_url_rs(&decoded_url).unwrap_or_else(|_| decoded_url.clone());

                match client.get(&decoded_url)
                    .header(reqwest::header::USER_AGENT, user_agent)
                    .header(reqwest::header::REFERER, referer_base)
                    .header(reqwest::header::ACCEPT, "*/*")
                    .send()
                    .await {
                    Ok(res) => {
                        let status = res.status().as_u16();
                        let mime_type = res.headers()
                            .get(reqwest::header::CONTENT_TYPE)
                            .and_then(|val| val.to_str().ok())
                            .unwrap_or("application/octet-stream")
                            .to_string();
                        match res.bytes().await {
                            Ok(bytes) => tauri::http::ResponseBuilder::new()
                                .status(status)
                                .mimetype(&mime_type)
                                .body(bytes.to_vec()),
                            Err(_) => tauri::http::ResponseBuilder::new().status(500).body(Vec::new()),
                        }
                    }
                    Err(_) => tauri::http::ResponseBuilder::new().status(500).body(Vec::new()),
                }
            };
            // 在Tauri的运行时中执行异步代码
            #[cfg(target_os = "android")] // 或者其他需要 tokio 的平台
            {
                let response = tokio::runtime::Handle::current().block_on(fut);
                response
            }
            #[cfg(not(target_os = "android"))] // 对于桌面端，可以使用 tauri::async_runtime
            {
                 tauri::async_runtime::block_on(fut)
            }
        })
        .setup(|app| {
            // 移动端初始化代码，例如请求权限
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

3.2. 实现 HTTP 请求与内容获取 (Rust 版 fetchContentWithType)
需要 reqwest crate。在 src-tauri/Cargo.toml 中添加:

```toml
[dependencies]
reqwest = { version = "0.11", features = ["json", "rustls-tls"] } # 使用 rustls-tls 避免 OpenSSL 依赖
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
tokio = { version = "1", features = ["full"] } # reqwest 需要 tokio 运行时
url = "2.2"
rand = "0.8"
urlencoding = "2.1"
log = "0.4" // 可选，用于日志
env_logger = "0.9" // 可选
```

```

// src-tauri/src/proxy_handler.rs (或 main.rs)
```
async fn fetch_content_with_type_rs(
    target_url: &str,
    app_state: &tauri::State<'_, AppState>,
) -> Result<FetchResult, ErrorResult> {
    let client = reqwest::Client::new(); // 考虑在 AppState 中创建并复用 Client
    let user_agent = app_state.get_random_user_agent();

    // 尝试从目标URL自身获取 origin 作为 Referer
    let referer = match url::Url::parse(target_url) {
        Ok(parsed_url) => parsed_url.origin().unicode_serialization(),
        Err(_) => target_url.to_string(), // Fallback
    };

    println!("[Rust fetch] UA: {}, Referer: {}", user_agent, referer);

    match client
        .get(target_url)
        .header(reqwest::header::USER_AGENT, &user_agent)
        .header(reqwest::header::ACCEPT, "*/*")
        .header(reqwest::header::ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
        .header(reqwest::header::REFERER, &referer)
        .timeout(std::time::Duration::from_secs(20)) // 设置超时
        .send()
        .await
    {
        Ok(response) => {
            if !response.status().is_success() {
                let status = response.status();
                let error_body = response.text().await.unwrap_or_default();
                return Err(ErrorResult {
                    error: format!("HTTP error {}: {}", status, error_body.chars().take(200).collect::<String>()),
                });
            }
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .map_or_else(|| "".to_string(), |h| h.to_str().unwrap_or("").to_string());

            // 注意：如果内容是二进制的（如图片、视频片段），直接 text() 会有问题
            // 但对于 M3U8 和 JSON，text() 是可以的
            let content = response.text().await.map_err(|e| ErrorResult { error: e.to_string() })?;

            Ok(FetchResult {
                content,
                content_type,
            })
        }
        Err(e) => Err(ErrorResult { error: e.to_string() }),
    }
}

3.3. 实现 M3U8 内容判断与解析 (Rust 版 isM3u8Content, getBaseUrl, resolveUrl)```

// src-tauri/src/proxy_handler.rs (或 main.rs)
```
fn is_m3u8_content_rs(content: &str, content_type: &str) -> bool {
    if content_type.contains("application/vnd.apple.mpegurl")
        || content_type.contains("application/x-mpegurl")
        || content_type.contains("audio/mpegurl")
    {
        return true;
    }
    content.trim_start().starts_with("#EXTM3U")
}

fn get_base_url_rs(url_str: &str) -> Result<String, url::ParseError> {
    let parsed_url = url::Url::parse(url_str)?;
    // 如果路径只有文件名或根目录，返回 origin + "/"
    if parsed_url.path_segments().map_or(true, |mut s| s.next().is_none() || s.clone().count() <= 1 && !parsed_url.path().ends_with('/')) {
         return Ok(format!("{}://{}/", parsed_url.scheme(), parsed_url.host_str().unwrap_or_default()));
    }

    // 移除路径的最后一部分
    let mut new_url = parsed_url.clone();
    if new_url.path().ends_with('/') { // 如果已经是目录，直接用
        Ok(new_url.as_str().to_string())
    } else { // 否则移除文件名
        let mut segments: Vec<&str> = new_url.path_segments().map_or_else(Vec::new, |s| s.collect());
        if !segments.is_empty() {
            segments.pop();
        }
        let new_path = segments.join("/");
        new_url.set_path(&format!("/{}/", new_path)); // 确保以斜杠结尾
        Ok(new_url.as_str().to_string())
    }
}


fn resolve_url_rs(base_url_str: &str, relative_url_str: &str) -> Result<String, String> {
    if relative_url_str.starts_with("http://") || relative_url_str.starts_with("https://") {
        return Ok(relative_url_str.to_string());
    }
    let base_url = url::Url::parse(base_url_str).map_err(|e| format!("Invalid base URL: {}", e))?;
    base_url.join(relative_url_str).map(|u| u.into_string()).map_err(|e| format!("URL join error: {:?}", e))
}
```

// Rust 版 rewriteUrlToProxy
```
// 方案A: 生成一个可被JS invoke调用的标记，或者直接返回原始URL让JS处理
// 方案B: 生成自定义协议URL
fn rewrite_url_to_proxy_rs(target_url: &str, use_custom_protocol: bool) -> String {
    if use_custom_protocol {
        // 方案 B: 使用自定义协议
        format!("app-media://{}", urlencoding::encode(target_url))
    } else {
        // 方案 A: 返回原始 URL，让 JS 的 HLS loader 通过 invoke 调用 Rust
        // 或者，如果 HLS.js loader 可以被配置为直接调用异步函数获取片段：
        // JS 端需要一种方式识别这些URL，然后调用 invoke('fetch_resource_segment', { target_url })
        // 这里暂时返回原始URL，具体处理看前端HLS loader的修改
        target_url.to_string()
    }
}

3.4. 实现 M3U8 内容处理 (Rust 版 processM3u8Content, processMasterPlaylist, processMediaPlaylist)
这部分是最复杂的，需要仔细进行字符串处理或寻找 M3U8 解析库。为简化，这里展示一个基于字符串分割和替换的思路。
```

// src-tauri/src/proxy_handler.rs (或 main.rs)
```
const MAX_RECURSION: u8 = 5;

async fn process_m3u8_content_rs(
    target_url: &str,
    content: String,
    recursion_depth: u8,
    app_state: &tauri::State<'_, AppState>,
) -> Result<String, String> {
    if recursion_depth > MAX_RECURSION {
        return Err(format!("Max recursion depth exceeded for M3U8: {}", target_url));
    }

    if content.contains("#EXT-X-STREAM-INF") || content.contains("#EXT-X-MEDIA:") {
        println!("[Rust M3U8] Processing Master Playlist: {}", target_url);
        process_master_playlist_rs(target_url, &content, recursion_depth, app_state).await
    } else {
        println!("[Rust M3U8] Processing Media Playlist: {}", target_url);
        process_media_playlist_rs(target_url, &content, app_state) // app_state 传递给 rewrite_url_to_proxy_rs
    }
}

async fn process_master_playlist_rs(
    url_str: &str,
    content: &str,
    recursion_depth: u8,
    app_state: &tauri::State<'_, AppState>,
) -> Result<String, String> {
    let base_url = get_base_url_rs(url_str).map_err(|e| e.to_string())?;
    let mut highest_bandwidth = -1;
    let mut best_variant_url: Option<String> = None;

    let lines: Vec<&str> = content.lines().collect();
    for i in 0..lines.len() {
        if lines[i].starts_with("#EXT-X-STREAM-INF") {
            let bandwidth_match = lines[i]
                .split(',')
                .find(|s| s.starts_with("BANDWIDTH="))
                .and_then(|s| s.split('=').nth(1))
                .and_then(|s| s.parse::<i64>().ok());

            let current_bandwidth = bandwidth_match.unwrap_or(0);

            if i + 1 < lines.len() && !lines[i+1].trim().is_empty() && !lines[i+1].starts_with('#') {
                let variant_uri = lines[i+1].trim();
                if current_bandwidth >= highest_bandwidth {
                    highest_bandwidth = current_bandwidth;
                    best_variant_url = Some(resolve_url_rs(&base_url, variant_uri)?);
                }
            }
        }
    }

    // 如果没有找到带宽信息，尝试找第一个 .m3u8 链接
    if best_variant_url.is_none() {
        for line in lines.iter() {
            let trimmed_line = line.trim();
            if !trimmed_line.is_empty() && !trimmed_line.starts_with('#') && trimmed_line.contains(".m3u8") {
                 best_variant_url = Some(resolve_url_rs(&base_url, trimmed_line)?);
                 println!("[Rust M3U8] Master fallback, found sub-playlist: {:?}", best_variant_url);
                 break;
            }
        }
    }


    if let Some(variant_url) = best_variant_url {
        println!("[Rust M3U8] Selected variant: {} (BW: {})", variant_url, highest_bandwidth);
        // 获取子列表内容
        let sub_playlist_data = fetch_content_with_type_rs(&variant_url, app_state).await?;
        if is_m3u8_content_rs(&sub_playlist_data.content, &sub_playlist_data.content_type) {
            process_m3u8_content_rs(&variant_url, sub_playlist_data.content, recursion_depth + 1, app_state).await
        } else {
            // 如果子列表不是M3U8，可能直接是媒体文件，或者我们无法处理，按媒体列表处理其“内容”
             println!("[Rust M3U8] Fetched sub-playlist is not M3U8, processing as media playlist: {}", variant_url);
            process_media_playlist_rs(&variant_url, &sub_playlist_data.content, app_state)
        }
    } else {
        // 没有找到合适的子列表，尝试将当前内容作为媒体列表处理
        println!("[Rust M3U8] No sub-playlist found in master, processing current content as media playlist: {}", url_str);
        process_media_playlist_rs(url_str, content, app_state)
    }
}

fn process_media_playlist_rs(
    url_str: &str,
    content: &str,
    _app_state: &tauri::State<'_, AppState>, // _app_state 用于将来可能的配置，如 use_custom_protocol
) -> Result<String, String> {
    let base_url = get_base_url_rs(url_str).map_err(|e| e.to_string())?;
    let mut output_lines = Vec::new();
    let use_custom_protocol = true; // 推荐使用自定义协议

    for line in content.lines() {
        let trimmed_line = line.trim();
        if trimmed_line.is_empty() {
            // 保留可能的尾部空行
            if output_lines.last().map_or(false, |l: &String| !l.is_empty()) || content.ends_with("\n\n") && line == "" && output_lines.len() == content.lines().count() -1 {
                 output_lines.push(trimmed_line.to_string());
            }
            continue;
        }

        if trimmed_line.starts_with("#EXT-X-KEY") {
            // Example: #EXT-X-KEY:METHOD=AES-128,URI="key.key",IV=0x123
            let parts: Vec<&str> = trimmed_line.split(',').collect();
            let mut new_parts = Vec::new();
            for part in parts {
                if part.starts_with("URI=\"") {
                    let uri_val = part.trim_start_matches("URI=\"").trim_end_matches('\"');
                    let absolute_uri = resolve_url_rs(&base_url, uri_val)?;
                    let proxied_uri = rewrite_url_to_proxy_rs(&absolute_uri, use_custom_protocol);
                    new_parts.push(format!("URI=\"{}\"", proxied_uri));
                } else {
                    new_parts.push(part.to_string());
                }
            }
            output_lines.push(new_parts.join(","));
        } else if trimmed_line.starts_with("#EXT-X-MAP") {
            // Example: #EXT-X-MAP:URI="init.mp4"
             if let Some(uri_start) = trimmed_line.find("URI=\"") {
                let uri_and_rest = &trimmed_line[uri_start + 5..];
                if let Some(uri_end) = uri_and_rest.find('\"') {
                    let uri_val = &uri_and_rest[..uri_end];
                    let absolute_uri = resolve_url_rs(&base_url, uri_val)?;
                    let proxied_uri = rewrite_url_to_proxy_rs(&absolute_uri, use_custom_protocol);
                    output_lines.push(format!("{}URI=\"{}\"{}", &trimmed_line[..uri_start], proxied_uri, &uri_and_rest[uri_end+1..]));
                } else { output_lines.push(trimmed_line.to_string()); }
             } else { output_lines.push(trimmed_line.to_string()); }
        } else if !trimmed_line.starts_with('#') {
            let absolute_url = resolve_url_rs(&base_url, trimmed_line)?;
            output_lines.push(rewrite_url_to_proxy_rs(&absolute_url, use_custom_protocol));
        } else {
            output_lines.push(trimmed_line.to_string());
        }
    }
    Ok(output_lines.join("\n"))
}

4. 前端 JavaScript 修改

4.1. 修改 js/api.js

需要从 window.__TAURI__.tauri.invoke 或 window.__TAURI__.shell.invoke (取决于 Tauri 版本和你的导入方式) 调用 Rust 命令。

// js/api.js

// 确保在Tauri环境中
const invoke = window.__TAURI__?.tauri?.invoke || window.__TAURI__?.shell?.invoke;

async function handleApiRequest(url) { // url is a URL object
    const customApi = url.searchParams.get('customApi') || '';
    const source = url.searchParams.get('source') || 'heimuer'; // Default source

    try {
        if (!invoke) {
            throw new Error("Tauri API (invoke) is not available. Ensure you're running in a Tauri context.");
        }

        if (url.pathname === '/api/search') {
            const searchQuery = url.searchParams.get('wd');
            // ... (参数校验同原版) ...
            const apiUrl = customApi
                ? `${customApi}${API_CONFIG.search.path}${encodeURIComponent(searchQuery)}`
                : `${API_SITES[source].api}${API_CONFIG.search.path}${encodeURIComponent(searchQuery)}`;

            console.log(`[JS API Search] Calling Rust proxy for: ${apiUrl}`);
            const data = await invoke('proxy_fetch_content', { targetUrl: apiUrl });

            // Rust 命令直接返回 FetchResult { content: String, contentType: String }
            // 我们需要解析 content (JSON string)
            const jsonData = JSON.parse(data.content);

            if (!jsonData || !Array.isArray(jsonData.list)) {
                throw new Error('API返回的数据格式无效 (from Rust)');
            }
            jsonData.list.forEach(item => {
                item.source_name = source === 'custom' ? '自定义源' : API_SITES[source].name;
                item.source_code = source;
                if (source === 'custom') {
                    item.api_url = customApi;
                }
            });
            return JSON.stringify({ code: 200, list: jsonData.list || [] });

        } else if (url.pathname === '/api/detail') {
            const id = url.searchParams.get('id');
            // ... (参数校验同原版) ...
            // ... (特殊源处理逻辑，如果这些特殊源的详情页抓取逻辑复杂，也需要考虑是否部分移到Rust) ...
            // 例如，handleSpecialSourceDetail 内部的 fetch 也需要改成 invoke

            const detailUrl = customApi
                ? `${customApi}${API_CONFIG.detail.path}${id}`
                : `${API_SITES[sourceCode].api}${API_CONFIG.detail.path}${id}`;

            console.log(`[JS API Detail] Calling Rust proxy for: ${detailUrl}`);
            const data = await invoke('proxy_fetch_content', { targetUrl: detailUrl });
            const videoData = JSON.parse(data.content); // 解析Rust返回的 content

            // ... (后续处理 videoData 以提取剧集等信息的逻辑，与原版类似) ...
            // 注意：如果 videoData.list[0].vod_play_url 是 M3U8 链接，
            // 并且这个链接也需要通过代理获取并处理，那么这里可能需要再次调用 invoke
            // 或者 Rust 的 proxy_fetch_content 命令应该能处理递归的 M3U8 (主列表 -> 子列表)

            // 假设 videoData.list[0] 包含 M3U8 链接或可以直接播放的链接
            const videoDetail = videoData.list[0];
            let episodes = [];
            if (videoDetail.vod_play_url) {
                const playSources = videoDetail.vod_play_url.split('$$$');
                if (playSources.length > 0) {
                    const mainSource = playSources[0]; // 通常是M3U8
                    const episodeListRaw = mainSource.split('#');
                    episodes = episodeListRaw.map(ep => {
                        const parts = ep.split('$');
                        let playUrl = parts.length > 1 ? parts[1] : parts[0]; // $ 前是集数名，后是URL

                        // 如果 playUrl 是一个需要代理的 M3U8，它应该已经被 Rust 处理过了
                        // 如果它是一个直接的 mp4/ts 等，或者是一个指向我们自定义协议的 URL
                        // DPlayer 需要能处理这个 URL
                        return playUrl;
                    }).filter(url => url && (url.startsWith('http') || url.startsWith('app-media://'))); // 允许自定义协议
                }
            }
             // ... (其他信息提取) ...
            return JSON.stringify({
                code: 200,
                episodes: episodes,
                // ... videoInfo
            });
        }
        throw new Error('未知的API路径');
    } catch (error) {
        console.error('Tauri API处理错误:', error);
        let errorMessage = '请求处理失败';
        if (typeof error === 'string') errorMessage = error;
        else if (error.message) errorMessage = error.message;
        else if (error.error) errorMessage = error.error; // 来自Rust的ErrorResult

        return JSON.stringify({
            code: 400,
            msg: `Tauri: ${errorMessage}`,
            list: [],
            episodes: [],
        });
    }
}

// `PROXY_URL` 在 `js/config.js` 中可以废弃或注释掉了
// 因为我们不再通过 HTTP 访问 `/proxy/`，而是直接调用 Rust
// const PROXY_URL = '/proxy/'; // 可以移除

// fetch 拦截器中，不再需要 PROXY_URL + encodeURIComponent(apiUrl)
// 而是直接调用 handleApiRequest(new URL(input, window.location.origin))
// handleApiRequest 内部会使用 invoke

4.2. 处理 player.html 中的视频流 URL

当 player.html 初始化 DPlayer 时，传入的 video.url：

如果是一个直接的 MP4/WebM 等链接，DPlayer 可以直接播放。
如果是一个 M3U8 链接，这个 M3U8 应该是已经被 Rust 的 proxy_fetch_content 命令处理过的。处理过的 M3U8 文件内部的片段 URL 和密钥 URL 应该已经被 rewrite_url_to_proxy_rs 替换。
DPlayer 的 customType.hls 部分：

// player.html
// ...
video: {
    url: videoUrl, // 这个 videoUrl 是从 js/app.js -> js/api.js -> Rust proxy_fetch_content 得到的
                   // 如果是 M3U8，它已经是被 Rust 处理过的 M3U8 字符串内容
    type: 'hls',
    customType: {
        hls: function(video, player) {
            if (Hls.isSupported()) {
                if (currentHls && currentHls.destroy) {
                    currentHls.destroy();
                }
                const hlsConfig = { /* ... 你的 HLS 配置 ... */ };

                // 如果 video.src 是一个指向 app-media:// 的 URL (M3U8 主文件)
                // 或者 video.src 是一个包含了 app-media:// 片段的 M3U8 字符串
                // HLS.js 需要能正确请求这些 app-media:// URL
                // Tauri 的自定义协议处理器会处理这些请求

                // 如果采用方案A (JS中转获取片段)
                // 你可能需要一个自定义的 HLS loader
                if (USE_CUSTOM_LOADER_FOR_SEGMENTS) { // 假设有这样一个配置
                    hlsConfig.loader = class TauriSegmentLoader extends Hls.DefaultConfig.loader {
                        constructor(config) {
                            super(config);
                            const load = this.load.bind(this);
                            this.load = async function(context, config, callbacks) {
                                // context.url 会是 M3U8 文件中解析出来的片段/密钥 URL
                                // 这个 URL 可能是原始的，也可能是被 rewrite_url_to_proxy_rs 标记过的
                                if (context.url.startsWith("original-media-url://")) { // 假设的标记
                                    const actualUrl = context.url.replace("original-media-url://", "");
                                    try {
                                        console.log(`[JS Loader] Invoking Rust for segment: ${actualUrl}`);
                                        // fetch_resource_segment 返回 ArrayBuffer 或 Uint8Array
                                        const data = await invoke('fetch_resource_segment', { targetUrl: actualUrl });
                                        const response = { data: new Uint8Array(data).buffer, url: context.url }; // HLS.js期望ArrayBuffer
                                        callbacks.onSuccess(response, { ttfb: 0, loaded: data.length }, context);
                                    } catch (e) {
                                        console.error("Error fetching segment via Tauri:", e);
                                        callbacks.onError(e, context, null);
                                    }
                                } else {
                                    // 对于非标记的URL（例如M3U8主文件本身，如果它不是通过自定义协议加载的）
                                    load(context, config, callbacks);
                                }
                            };
                        }
                    };
                }


                currentHls = new Hls(hlsConfig);
                // 如果 video.src 是 M3U8 字符串内容，需要通过 Blob URL 加载
                if (video.src.startsWith('#EXTM3U')) { // 粗略判断是否是M3U8内容
                    const blob = new Blob([video.src], { type: 'application/vnd.apple.mpegurl' });
                    const blobUrl = URL.createObjectURL(blob);
                    currentHls.loadSource(blobUrl);
                    currentHls.attachMedia(video);
                    currentHls.on(Hls.Events.MANIFEST_PARSED, function () {
                        video.play().catch(e => console.warn("Autoplay prevented:", e));
                        // 释放Blob URL
                        // URL.revokeObjectURL(blobUrl); // 注意：过早释放可能导致问题，HLS.js可能还需要它
                    });
                } else { // 假设 video.src 是一个可以直接加载的 URL (例如 app-media://path/to/master.m3u8)
                    currentHls.loadSource(video.src);
                    currentHls.attachMedia(video);
                     currentHls.on(Hls.Events.MANIFEST_PARSED, function () {
                        video.play().catch(e => console.warn("Autoplay prevented:", e));
                    });
                }

                // ... (HLS.js 错误处理等其他逻辑)
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                // 对于原生支持HLS的浏览器 (如Safari)
                video.src = video.src; // 如果是M3U8内容，也需要转成Blob URL
                video.addEventListener('loadedmetadata', function () {
                    video.play().catch(e => console.warn("Autoplay prevented:", e));
                });
            }
        }
    }
}
// ...

5. M3U8 片段和密钥的获取策略

当 HLS.js 解析由 Rust 处理过的 M3U8 文件时，它会遇到指向媒体片段 (.ts) 或加密密钥 (.key) 的 URL。这些 URL 已经被 rewrite_url_to_proxy_rs 修改。

5.1. 方案 A: 通过 Rust 命令中转获取 (JS Loader + invoke)

Rust 端: rewrite_url_to_proxy_rs 返回原始的绝对 URL (或者稍作标记，如 original-media-url://...)。提供一个 fetch_resource_segment 命令，接收原始 URL，获取内容并返回 Vec<u8>。
JS 端 (player.html):
在 HLS.js 的配置中提供一个自定义的 loader。
这个 loader 检查 URL。如果是需要代理的（通过标记或域名判断），则调用 await invoke('fetch_resource_segment', { targetUrl: actualUrl })。
将 Rust 返回的 Uint8Array (包装在 ArrayBuffer 中) 交给 HLS.js 的 callbacks.onSuccess。
优点: 实现相对直接，不需要平台特定的自定义协议配置。
缺点: 每次请求片段/密钥都需要 JS → Rust 的 IPC 调用，对于大量小文件，开销可能较大。HLS.js 的 loader API 可能需要仔细处理异步操作。
5.2. 方案 B: (推荐) 使用 Tauri 自定义协议

Rust 端:
rewrite_url_to_proxy_rs 将所有内部 URL（片段、密钥、子列表）重写为自定义协议的 URL，例如 app-media://ENCODED_ORIGINAL_URL。
在 main.rs 中使用 tauri::Builder::default().register_uri_scheme_protocol("app-media", handler_function) 注册一个处理器。
handler_function 接收到 app-media://... 请求后：
提取并解码 ENCODED_ORIGINAL_URL。
使用 reqwest 等库异步获取原始 URL 的内容。
构造一个 tauri::http::Response (包含状态码、MIME类型、字节内容) 并返回。
JS 端 (player.html):
DPlayer 和 HLS.js 会像处理普通 HTTP URL 一样处理 app-media://... URL。Tauri 会在底层拦截这些请求并交由 Rust 处理。
M3U8 主文件本身也可以通过 app-media://... 加载，如果 js/api.js 返回的是这种格式的 URL。
优点: 性能通常更好，因为请求直接由 WebView 底层和 Rust 处理，减少了 JS-Rust IPC 的次数。更符合 Web 的 URL 请求模型。
缺点: 需要正确配置自定义协议，确保异步请求在 Rust 处理器中正确执行并返回。
推荐方案 B，因为它更优雅且潜在性能更好。上面的 main.rs 示例中已经包含了 register_uri_scheme_protocol 的基本框架。你需要确保异步的 reqwest 调用在 Tauri 的异步上下文中正确执行（例如，使用 tauri::async_runtime::spawn 或在 block_on 中处理）。

6. 配置与环境变量处理

js/config.js:
API_SITES, API_CONFIG 等前端配置可以保留。
PROXY_URL 不再需要。
PASSWORD_CONFIG: 前端密码逻辑可以保留，但密码哈希的来源需要改变。
密码哈希:
原先通过服务器端注入 window.__ENV__.PASSWORD。在 Tauri 中，可以在 Rust 的 setup 钩子中读取环境变量 PASSWORD (在 tauri.conf.json > tauri > bundle > Macos/Windows/Linux > env 中设置，或构建时传入)，计算哈希，然后通过 app.emit_all("app-config", YourConfigStruct) 或 window.eval(&format!("window.__ENV__ = {{ PASSWORD: '{}' }};", hash)) 将其传递给前端。
USER_AGENTS_JSON, DEBUG, CACHE_TTL, MAX_RECURSION:
这些现在是 Rust 代理逻辑的一部分。可以在 Rust 中通过读取环境变量 (使用 std::env::var) 或一个简单的配置文件 (如 src-tauri/config.json，使用 serde_json 读取) 来管理。
AppState 是存放这些配置的好地方。
7. 本地存储 (localStorage)
localStorage 在 Tauri 的 WebView 中通常可以正常工作，用于存储用户设置、搜索历史、观看历史等。如果需要更持久或结构化的存储，可以考虑：

tauri-plugin-store: 一个官方插件，提供基于 JSON 文件的持久化键值存储。
SQLite: 通过 tauri-plugin-sql 插件或 Rust 的 rusqlite crate 直接操作 SQLite 数据库，功能更强大。
对于 LibreTV 的现有需求，localStorage 应该足够，迁移成本最低。

8. 构建与打包移动应用
配置 tauri.conf.json:

确保 tauri.bundle.identifier 是一个唯一的应用 ID (例如 com.libretv.mobile)。
填写 productName, version 等信息。
针对 Android 和 iOS 配置 tauri.bundle.android 和 tauri.bundle.ios 部分，例如图标、权限等。
权限:
Android (src-tauri/AndroidManifest.xml): 需要 android.permission.INTERNET。如果使用自定义协议可能还需要其他配置。
iOS (src-tauri/Info.plist): 确保网络访问权限。
构建命令:

cargo tauri android build
cargo tauri ios build

这会在 src-tauri/target/release/mobile (或类似路径)下生成 .apk/.aab (Android) 和 .app/.ipa (iOS) 文件。

9. 分步实现计划
阶段一: Tauri 项目搭建与 Web 集成 (1-2天)

 初始化 Tauri 项目，配置 tauri.conf.json。
 将 LibreTV 的 HTML/CSS/JS 文件复制到 distDir。
 确保 index.html 能在桌面 cargo tauri dev 中正确显示（无代理功能）。
 尝试在 Android/iOS 模拟器或设备上运行。
阶段二: 简单的 Rust 命令与 JS 调用 (1天)

 在 main.rs 中创建一个简单的 Tauri 命令，例如 greet(name: String) -> String。
 在 js/app.js 或 index.html 的 <script> 中尝试调用此命令并显示结果。
阶段三: Rust HTTP 请求功能 (2-3天)

 在 Rust 中实现 fetch_content_with_type_rs，能够获取指定 URL 的文本内容和 Content-Type。
 创建一个 Tauri 命令，例如 raw_fetch(url: String) -> Result<FetchResult, String>，让 JS 可以调用它来获取原始网页内容。
 修改 js/api.js 中的一个简单搜索请求，使其通过 raw_fetch 获取数据，验证网络请求通路。
阶段四: Rust M3U8 核心逻辑 (3-5天)

 在 Rust 中实现 is_m3u8_content_rs。
 实现 get_base_url_rs 和 resolve_url_rs。
 实现 rewrite_url_to_proxy_rs (决定采用方案A还是B的URL格式)。
 逐步实现 process_media_playlist_rs 和 process_master_playlist_rs。这部分最复杂，需要大量测试。可以先处理简单的媒体列表，再处理主列表。
 将这些功能整合到 proxy_fetch_content 命令中。
阶段五: 前端 API 对接 (2-3天)

 全面修改 js/api.js，将所有 fetch(PROXY_URL + ...) 调用替换为 invoke('proxy_fetch_content', { targetUrl: actual_api_url })。
 确保搜索和获取详情功能恢复正常，数据能正确传递和解析。
阶段六: 视频播放集成 (3-4天)

 确保 player.html 接收到的 M3U8 URL 是经过 Rust 处理的（或者 M3U8 内容本身）。
 实现片段/密钥获取:
如果方案A: 修改 player.html 中的 HLS.js loader，通过 invoke('fetch_resource_segment', ...) 获取数据。
如果方案B: 在 main.rs 中完整实现自定义协议处理器，确保 HLS.js 能通过 app-media://... URL 加载所有资源。
 彻底测试视频播放，包括不同类型的 M3U8。
阶段七: 配置、历史记录与其他功能 (1-2天)

 处理密码哈希的传递。
 确保 localStorage 功能 (设置、历史记录) 正常。
 检查豆瓣热门等其他辅助功能是否正常。
阶段八: 测试、调试与打包 (持续)

 在 Android 和 iOS 真机上进行广泛测试。
 调试特定平台的问题。
 生成最终的发布包。
10. 潜在挑战与调试技巧

Rust 学习曲线: 如果不熟悉 Rust，需要投入时间学习其语法、所有权模型和异步编程。
异步 Rust 与 Tauri: 确保 Rust 中的异步操作 (如 reqwest) 与 Tauri 的事件循环和命令系统正确集成。async move 和 block_on (在自定义协议中) 可能需要小心处理。
M3U8 复杂性: M3U8 格式多样，边缘情况多。纯字符串处理容易出错，如果能找到好的 Rust M3U8 解析库会很有帮助 (例如 m3u8-rs crate，但要注意其成熟度和功能是否满足需求)。
调试:
Rust 端: 使用 println! 或 log crate 进行日志输出。
JS 端: 浏览器开发者工具 (在桌面 cargo tauri dev 时可用)。
移动端: Android Studio 的 Logcat, Xcode 的 Console。Tauri 也可以配置将 Rust 日志输出到移动端控制台。
Tauri IPC 调试: 可以在 JS 端 console.log invoke 的参数和返回值，在 Rust 端 println! 命令接收到的参数和处理结果。
平台差异: 某些行为在 Android 和 iOS 上可能略有不同，需要分别测试。
WebView 限制: 虽然现代 WebView 很强大，但某些极端 Web API 或 CSS特性可能支持不一。DPlayer 和 HLS.js 对 WebView 的兼容性也需要关注。