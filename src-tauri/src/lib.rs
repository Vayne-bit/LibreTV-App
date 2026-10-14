use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime};
use tauri;
use tauri::Manager;
use once_cell::sync::{Lazy, OnceCell}; // For lazy static initialization

// --- API Configuration Structures ---

#[derive(Serialize, Deserialize, Debug, Clone)]
enum ApiType {
    Json,
    Html, // For sources where details are scraped from HTML
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct ApiSourceInfo {
    api_base_url: String,
    name: String,
    detail_base_url: Option<String>, // For HTML detail pages or different detail API base
    api_type: ApiType, // To distinguish between JSON API and HTML scraping for details
    search_path: Option<String>, // Specific search path if different from default
    detail_path: Option<String>, // Specific detail path if different from default (for JSON APIs)
    // Example: some sources might use /vodsearch instead of /api.php/provide/vod/...
}

// Using a more specific name for the map key if needed, e.g. SourceId(String)
static API_SITES_CONFIG: Lazy<HashMap<String, ApiSourceInfo>> = Lazy::new(|| {
    let mut m = HashMap::new();
    // Data from public/js/config.js API_SITES, adapted for Rust
    // Note: Detail paths for HTML sources are usually part of detail_base_url construction
    // Search paths and detail paths for JSON sources can use defaults or be overridden here
    
    // Example entry (need to populate all from config.js)
    m.insert("dyttzy".to_string(), ApiSourceInfo {
        api_base_url: "http://caiji.dyttzyapi.com".to_string(),
        name: "电影天堂资源".to_string(),
        detail_base_url: Some("http://caiji.dyttzyapi.com".to_string()), // Assuming it's JSON, or specific HTML base
        api_type: ApiType::Json, // Assuming JSON, adjust if it's HTML scraping for detail
        search_path: None, // Uses default
        detail_path: None, // Uses default
    });
    m.insert("ruyi".to_string(), ApiSourceInfo {
        api_base_url: "https://cj.rycjapi.com".to_string(),
        name: "如意资源".to_string(),
        detail_base_url: None,
        api_type: ApiType::Json,
        search_path: None, detail_path: None,
    });
    m.insert("bfzy".to_string(), ApiSourceInfo {
        api_base_url: "https://bfzyapi.com".to_string(),
        name: "暴风资源".to_string(),
        detail_base_url: None,
        api_type: ApiType::Json,
        search_path: None, detail_path: None,
    });
    m.insert("tyyszy".to_string(), ApiSourceInfo {
        api_base_url: "https://tyyszy.com".to_string(),
        name: "天涯资源".to_string(),
        detail_base_url: None,
        api_type: ApiType::Json,
        search_path: None, detail_path: None,
    });
    m.insert("xiaomaomi".to_string(), ApiSourceInfo {
        api_base_url: "https://zy.xiaomaomi.cc".to_string(),
        name: "小猫咪资源".to_string(),
        detail_base_url: None,
        api_type: ApiType::Json,
        search_path: None, detail_path: None,
    });
    m.insert("ffzy".to_string(), ApiSourceInfo { // ffzy has HTML detail
        api_base_url: "http://ffzy5.tv".to_string(),
        name: "非凡影视".to_string(),
        detail_base_url: Some("http://ffzy5.tv".to_string()), // Base for HTML detail
        api_type: ApiType::Html, // Detail is HTML
        search_path: None, // JSON search
        detail_path: Some("/index.php/vod/detail/id/{id}.html".to_string()), // Path template for HTML detail
    });
    m.insert("heimuer".to_string(), ApiSourceInfo { // heimuer has HTML detail
        api_base_url: "https://json.heimuer.xyz".to_string(),
        name: "黑木耳".to_string(),
        detail_base_url: Some("https://heimuer.tv".to_string()), // Base for HTML detail
        api_type: ApiType::Html, // Detail is HTML
        search_path: None, // JSON search
        detail_path: Some("/index.php/vod/detail/id/{id}.html".to_string()), // Path template for HTML detail
    });
    m.insert("zy360".to_string(), ApiSourceInfo {
        api_base_url: "https://360zy.com".to_string(),
        name: "360资源".to_string(),
        detail_base_url: None,
        api_type: ApiType::Json,
        search_path: None, detail_path: None,
    });
    m.insert("wolong".to_string(), ApiSourceInfo {
        api_base_url: "https://wolongzyw.com".to_string(),
        name: "卧龙资源".to_string(),
        detail_base_url: None,
        api_type: ApiType::Json,
        search_path: None, detail_path: None,
    });
    m.insert("hwba".to_string(), ApiSourceInfo {
        api_base_url: "https://cjhwba.com".to_string(),
        name: "华为吧资源".to_string(),
        detail_base_url: None,
        api_type: ApiType::Json,
        search_path: None, detail_path: None,
    });
    m.insert("jisu".to_string(), ApiSourceInfo {
        api_base_url: "https://jszyapi.com".to_string(),
        name: "极速资源".to_string(),
        detail_base_url: Some("https://jszyapi.com".to_string()),
        api_type: ApiType::Json, // Assuming JSON, adjust if HTML
        search_path: None, detail_path: None,
    });
    m.insert("dbzy".to_string(), ApiSourceInfo {
        api_base_url: "https://dbzy.com".to_string(),
        name: "豆瓣资源".to_string(),
        detail_base_url: None,
        api_type: ApiType::Json,
        search_path: None, detail_path: None,
    });
    m.insert("mozhua".to_string(), ApiSourceInfo {
        api_base_url: "https://mozhuazy.com".to_string(),
        name: "魔爪资源".to_string(),
        detail_base_url: None,
        api_type: ApiType::Json,
        search_path: None, detail_path: None,
    });
    m.insert("mdzy".to_string(), ApiSourceInfo {
        api_base_url: "https://www.mdzyapi.com".to_string(),
        name: "魔都资源".to_string(),
        detail_base_url: None,
        api_type: ApiType::Json,
        search_path: None, detail_path: None,
    });
    m.insert("zuid".to_string(), ApiSourceInfo {
        api_base_url: "https://api.zuidapi.com".to_string(),
        name: "最大资源".to_string(),
        detail_base_url: None,
        api_type: ApiType::Json,
        search_path: None, detail_path: None,
    });
    m.insert("yinghua".to_string(), ApiSourceInfo {
        api_base_url: "https://m3u8.apiyhzy.com".to_string(),
        name: "樱花资源".to_string(),
        detail_base_url: None,
        api_type: ApiType::Json,
        search_path: None, detail_path: None,
    });
    m.insert("baidu".to_string(), ApiSourceInfo {
        api_base_url: "https://api.apibdzy.com".to_string(),
        name: "百度云资源".to_string(),
        detail_base_url: None,
        api_type: ApiType::Json,
        search_path: None, detail_path: None,
    });
    m.insert("wujin".to_string(), ApiSourceInfo {
        api_base_url: "https://api.wujinapi.me".to_string(),
        name: "无尽资源".to_string(),
        detail_base_url: None,
        api_type: ApiType::Json,
        search_path: None, detail_path: None,
    });
    m.insert("wwzy".to_string(), ApiSourceInfo {
        api_base_url: "https://wwzy.tv".to_string(),
        name: "旺旺短剧".to_string(),
        detail_base_url: None, // Assuming JSON, adjust if HTML
        api_type: ApiType::Json,
        search_path: None, detail_path: None,
    });
    m.insert("ikun".to_string(), ApiSourceInfo {
        api_base_url: "https://ikunzyapi.com".to_string(),
        name: "iKun资源".to_string(),
        detail_base_url: None,
        api_type: ApiType::Json,
        search_path: None, detail_path: None,
    });
    // Add other sources from config.js here...
    m
});

struct ApiPathConfig {
    search: String,
    // detail_json: String, // For JSON detail APIs // Commented out to avoid dead_code warning for now
    // HTML detail paths are part of ApiSourceInfo.detail_path_template
}

static API_PATH_DEFAULTS: Lazy<ApiPathConfig> = Lazy::new(|| ApiPathConfig {
    search: "/api.php/provide/vod/?ac=videolist&wd=".to_string(),
    // detail_json: "/api.php/provide/vod/?ac=videolist&ids=".to_string(), // Commented out
});

// --- End API Configuration Structures ---

// --- New Tauri Commands for API access ---

#[derive(Serialize, Deserialize, Debug)]
struct SearchResultItem {
    // Define fields based on what the JS expects in the 'list' array
    // e.g., vod_id, vod_name, vod_pic, type_name, vod_remarks, etc.
    // For now, we'll assume the body from make_http_request is a JSON string
    // that the frontend can parse directly. If we need to process it in Rust,
    // we'd define more specific structs here.
    // This command will return the raw JSON string body for now.
}

#[derive(Serialize, Deserialize, Debug)]
struct SearchResponse {
    code: u16,
    msg: Option<String>,
    list: serde_json::Value, // Assuming list can be any array of objects
                             // Or define a Vec<SearchResultItem> if item structure is fixed
}


#[tauri::command]
async fn search_videos(
    query: String,
    source_id: String,
    custom_api_url: Option<String>,
) -> Result<String, HttpError> {
    let source_info: ApiSourceInfo;
    let base_url: String;

    if source_id == "custom" {
        match custom_api_url {
            Some(url) => {
                base_url = url;
                // For custom, we might not have a full ApiSourceInfo,
                // or we create a temporary one.
                // For now, assume custom sources use default paths.
                source_info = ApiSourceInfo {
                    api_base_url: base_url.clone(),
                    name: "Custom".to_string(),
                    detail_base_url: None,
                    api_type: ApiType::Json, // Assume custom is JSON for search
                    search_path: None,
                    detail_path: None,
                };
            }
            None => {
                return Err(HttpError {
                    error: "Custom source selected but no API URL provided".to_string(),
                    details: None,
                });
            }
        }
    } else {
        match API_SITES_CONFIG.get(&source_id) {
            Some(info) => {
                source_info = info.clone();
                base_url = source_info.api_base_url.clone();
            }
            None => {
                return Err(HttpError {
                    error: format!("Unknown source_id: {}", source_id),
                    details: None,
                });
            }
        }
    }

    let search_path_template = source_info.search_path.as_deref().unwrap_or(&API_PATH_DEFAULTS.search);
    // Ensure query is URL encoded
    let encoded_query = urlencoding::encode(&query);
    let full_url = format!("{}{}{}", base_url, search_path_template, encoded_query);

    // Prepare headers - use defaults from API_CONFIG in JS for now
    // Later, API_CONFIG.search.headers can also be moved to Rust
    let mut headers = HashMap::new();
    headers.insert("User-Agent".to_string(), "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36".to_string());
    headers.insert("Accept".to_string(), "application/json".to_string());
    
    let http_options = HttpRequestOptions {
        url: full_url,
        method: Some("GET".to_string()),
        headers: Some(headers),
        body: None,
        timeout_secs: Some(20), // Default timeout
        response_as_text: Some(true), // Get raw body to pass to JS
    };

    match make_http_request(http_options).await {
        Ok(http_response) => {
            if http_response.status >= 200 && http_response.status < 300 {
                // The JS side expects a JSON string that it will parse.
                // The body from make_http_request is already a String.
                // We need to ensure this string is a valid JSON that the frontend expects.
                // For now, we directly return the body.
                // The JS `handleSingleSourceSearch` adds source_name and source_code to each item.
                // This logic might need to be replicated here if we return a parsed struct,
                // or the JS can continue doing that after receiving the list.
                // To match the JS function's return { code: 200, list: ... },
                // we might need to parse here and re-serialize, or adjust JS.
                // For now, let's assume the body is the JSON string the JS handler would have produced
                // for the "list" part, and JS will wrap it.
                // OR, more simply, return the raw body and let JS parse it.
                // The original JS `handleSingleSourceSearch` returns JSON.stringify({ code: 200, list: responseData.list || [] });
                // So, if make_http_request's body is the direct API JSON, we might need to parse it,
                // extract the list, and then re-wrap.

                // Directly return the body string as per our design.
                // JS side (handleSingleSourceSearch) will parse this JSON string.
                Ok(http_response.body)
            } else {
                Err(HttpError {
                    error: format!("API request failed with status: {}", http_response.status),
                    details: Some(http_response.body),
                })
            }
        }
        Err(e) => Err(e), // Propagate error from make_http_request
    }
}


// --- End New Tauri Commands ---


#[derive(Serialize, Deserialize, Debug)]
pub struct HttpRequestOptions {
    url: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body: Option<serde_json::Value>,
    timeout_secs: Option<u64>,
    response_as_text: Option<bool>, // New field
}

#[derive(Serialize, Deserialize, Debug)]
pub struct HttpResponse {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct HttpError {
    error: String,
    details: Option<String>,
}

// One pooled client so repeated requests to the same source reuse connections.
static HTTP_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
});

#[tauri::command]
async fn make_http_request(options: HttpRequestOptions) -> Result<HttpResponse, HttpError> { // Removed pub
    log::debug!("[Rust] make_http_request called with URL: {}, Method: {:?}, Headers: {:?}, Timeout: {:?}", 
        options.url, 
        options.method, 
        options.headers, 
        options.timeout_secs
    );

    let timeout_duration = Duration::from_secs(options.timeout_secs.unwrap_or(20));

    let method_str = options.method.unwrap_or_else(|| "GET".to_string());
    let method_for_reqwest = match method_str.to_uppercase().as_str() {
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        "PATCH" => reqwest::Method::PATCH,
        _ => reqwest::Method::GET,
    };

    let mut request_builder = HTTP_CLIENT
        .request(method_for_reqwest.clone(), &options.url)
        .timeout(timeout_duration);

    let mut req_headers = HeaderMap::new();
    req_headers.insert(USER_AGENT, HeaderValue::from_static("LibreTV-TauriApp/1.0"));

    if let Some(h) = options.headers {
        for (key, value) in h {
            if let Ok(header_name) = reqwest::header::HeaderName::from_bytes(key.as_bytes()) {
                if let Ok(header_value) = HeaderValue::from_str(&value) {
                    req_headers.insert(header_name, header_value);
                } else {
                    eprintln!("Invalid header value for {}: {}", key, value);
                }
            } else {
                 eprintln!("Invalid header name: {}", key);
            }
        }
    }
    request_builder = request_builder.headers(req_headers.clone());

    if let Some(body_value) = options.body {
        let content_type_is_json = req_headers
            .get(CONTENT_TYPE)
            .map_or(false, |ct| ct.to_str().unwrap_or("").contains("application/json"));

        if method_str.eq_ignore_ascii_case("POST") || method_str.eq_ignore_ascii_case("PUT") || method_str.eq_ignore_ascii_case("PATCH") { // Removed unnecessary parentheses
            if content_type_is_json {
                 request_builder = request_builder.json(&body_value);
            } else if let Some(body_str) = body_value.as_str() {
                 request_builder = request_builder.body(body_str.to_string());
            } else {
                 request_builder = request_builder.body(body_value.to_string());
            }
        }
    }
    
    match request_builder.send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            let mut resp_headers = HashMap::new();
            for (key, value) in response.headers().iter() {
                if let Ok(val_str) = value.to_str() {
                    resp_headers.insert(key.as_str().to_string(), val_str.to_string());
                }
            }
            
            match response.text().await {
                Ok(text_body) => {
                    log::debug!("[Rust] make_http_request successful for URL: {}. Status: {}. Response body (first 100 chars): {:.100}", options.url, status, text_body);
                    Ok(HttpResponse {
                        status,
                        headers: resp_headers,
                        body: text_body,
                    })
                },
                Err(e) => {
                    log::error!("[Rust] make_http_request failed to read response body for URL: {}. Error: {}", options.url, e);
                    Err(HttpError { error: "Failed to read response body".to_string(), details: Some(e.to_string()) })
                }
            }
        }
        Err(e) => {
            log::error!("[Rust] make_http_request failed for URL: {}. Error: {}", options.url, e);
            let error_details = e.to_string();
            let error_type = if e.is_timeout() { "Request timed out".to_string() }
                else if e.is_connect() { "Connection error".to_string() }
                else if e.is_builder() { "Request builder error".to_string() }
                else if e.is_redirect() { "Redirect policy error".to_string() }
                else if e.is_status() { format!("HTTP status error: {}", e.status().map_or_else(|| "Unknown".to_string(), |s| s.as_u16().to_string())) }
                else if e.is_body() { "Response body error".to_string() }
                else if e.is_decode() { "Response decoding error".to_string() }
                else { "HTTP request failed".to_string() };
            Err(HttpError { error: error_type, details: Some(error_details) })
        }
    }
}

#[tauri::command]
fn set_window_fullscreen(window: tauri::WebviewWindow, fullscreen: bool) -> Result<(), String> {
    #[cfg(desktop)]
    window.set_fullscreen(fullscreen).map_err(|e| e.to_string())?;
    #[cfg(mobile)]
    let _ = (window, fullscreen);
    Ok(())
}

#[derive(Serialize)]
struct ProbeResult {
    ok: bool,
    status: u16,
    ms: u64,
}

// Measures time to response headers only; the body is never read, so probing an mp4 does not download it.
#[tauri::command]
async fn probe_url(url: String, timeout_secs: Option<u64>) -> ProbeResult {
    let started = Instant::now();
    let result = HTTP_CLIENT
        .get(&url)
        .header(USER_AGENT, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        .timeout(Duration::from_secs(timeout_secs.unwrap_or(5)))
        .send()
        .await;
    let ms = started.elapsed().as_millis() as u64;
    match result {
        Ok(response) => {
            let status = response.status();
            ProbeResult { ok: status.is_success(), status: status.as_u16(), ms }
        }
        Err(_) => ProbeResult { ok: false, status: 0, ms },
    }
}

// --- Image proxy (imgproxy://localhost/?u=<encoded url>) ---
// Douban and many collection sites reject hotlinked covers, so images are fetched natively with a suitable Referer.

static IMAGE_CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
});

fn image_proxy_target(uri: &tauri::http::Uri) -> Option<reqwest::Url> {
    let query = uri.query()?;
    let raw = query.split('&').find_map(|pair| pair.strip_prefix("u="))?;
    let decoded = urlencoding::decode(raw).ok()?;
    let url = reqwest::Url::parse(&decoded).ok()?;
    matches!(url.scheme(), "http" | "https").then_some(url)
}

fn image_proxy_referer(url: &reqwest::Url) -> String {
    let host = url.host_str().unwrap_or_default();
    if host.ends_with("doubanio.com") || host.ends_with("douban.com") {
        "https://movie.douban.com/".to_string()
    } else {
        format!("{}://{}/", url.scheme(), url.authority())
    }
}

fn image_proxy_error(status: u16) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .body(Vec::new())
        .unwrap()
}

fn image_response(bytes: Vec<u8>, content_type: &str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", content_type)
        .header("Cache-Control", "max-age=86400")
        .header("Access-Control-Allow-Origin", "*")
        .body(bytes)
        .unwrap_or_else(|_| image_proxy_error(500))
}

// --- Image disk cache: the WebView does not cache custom-scheme responses, so covers are kept on disk. ---

static IMAGE_CACHE_DIR: OnceCell<PathBuf> = OnceCell::new();
const IMAGE_CACHE_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const IMAGE_CACHE_MAX_BYTES: u64 = 200 * 1024 * 1024;
const IMAGE_CACHE_TARGET_BYTES: u64 = 150 * 1024 * 1024;

// FNV-1a 64: stable across builds, so cache file names survive app updates.
fn image_cache_key(url: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in url.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{:016x}", hash)
}

fn is_fresh_cache_file(meta: &std::fs::Metadata) -> bool {
    meta.modified()
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .map_or(false, |age| age < IMAGE_CACHE_MAX_AGE)
}

fn read_cached_image(path: &Path) -> Option<Vec<u8>> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || !is_fresh_cache_file(&meta) {
        return None;
    }
    std::fs::read(path).ok().filter(|bytes| !bytes.is_empty())
}

static IMAGE_CACHE_TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn write_cached_image(path: &Path, bytes: &[u8]) {
    let tmp = path.with_extension(format!("tmp{}", IMAGE_CACHE_TMP_COUNTER.fetch_add(1, Ordering::Relaxed)));
    if std::fs::write(&tmp, bytes).is_ok() && std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

fn sniff_image_type(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        "image/jpeg"
    } else if bytes.starts_with(b"\x89PNG") {
        "image/png"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && (&bytes[8..12] == b"avif" || &bytes[8..12] == b"avis") {
        "image/avif"
    } else if bytes.starts_with(b"<") {
        "image/svg+xml"
    } else {
        "image/jpeg"
    }
}

fn prune_image_cache(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(PathBuf, SystemTime, u64)> = Vec::new();
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let path = entry.path();
        if !is_fresh_cache_file(&meta) {
            let _ = std::fs::remove_file(&path);
            continue;
        }
        files.push((path, meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), meta.len()));
    }
    let mut total: u64 = files.iter().map(|file| file.2).sum();
    if total <= IMAGE_CACHE_MAX_BYTES {
        return;
    }
    files.sort_by_key(|file| file.1);
    for (path, _, size) in files {
        if total <= IMAGE_CACHE_TARGET_BYTES {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
        }
    }
}

async fn proxy_image(uri: tauri::http::Uri) -> tauri::http::Response<Vec<u8>> {
    let Some(url) = image_proxy_target(&uri) else {
        return image_proxy_error(400);
    };
    let cache_path = IMAGE_CACHE_DIR.get().map(|dir| dir.join(image_cache_key(url.as_str())));
    if let Some(path) = cache_path.clone() {
        let cached = tauri::async_runtime::spawn_blocking(move || read_cached_image(&path))
            .await
            .ok()
            .flatten();
        if let Some(bytes) = cached {
            let content_type = sniff_image_type(&bytes);
            return image_response(bytes, content_type);
        }
    }
    let referer = image_proxy_referer(&url);
    let response = match IMAGE_CLIENT
        .get(url)
        .header(reqwest::header::REFERER, referer)
        .header(reqwest::header::ACCEPT, "image/avif,image/webp,image/apng,image/*,*/*;q=0.8")
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return image_proxy_error(502),
    };
    let status = response.status();
    if !status.is_success() {
        return image_proxy_error(status.as_u16());
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();
    if !content_type.starts_with("image/") && !content_type.starts_with("application/octet-stream") {
        return image_proxy_error(415);
    }
    match response.bytes().await {
        Ok(bytes) => {
            let bytes = bytes.to_vec();
            if let Some(path) = cache_path {
                if !bytes.is_empty() {
                    let data = bytes.clone();
                    tauri::async_runtime::spawn_blocking(move || write_cached_image(&path, &data));
                }
            }
            image_response(bytes, &content_type)
        }
        Err(_) => image_proxy_error(502),
    }
}

// use tauri_plugin_log::{Builder, Target}; // Temporarily commented out

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // let mut log_builder = Builder::default(); // Temporarily commented out
  // log_builder = log_builder.target(Target::Stdout); // Temporarily commented out
  // log_builder = log_builder.target(Target::Webview); // Temporarily commented out
  // #[cfg(target_os = "android")]
  // {
    // log_builder = log_builder.target(Target::Os); // Temporarily commented out
  // }
  
  tauri::Builder::default()
    // .plugin( // Temporarily commented out
        // log_builder
            // .level(log::LevelFilter::Debug) 
            // .build()
    // )
    .register_asynchronous_uri_scheme_protocol("imgproxy", |_ctx, request, responder| {
        let uri = request.uri().clone();
        tauri::async_runtime::spawn(async move {
            responder.respond(proxy_image(uri).await);
        });
    })
    .invoke_handler(tauri::generate_handler![
        make_http_request,
        search_videos,
        set_window_fullscreen,
        probe_url
    ])
    .setup(|app| {
      if let Ok(cache_dir) = app.path().app_cache_dir() {
          let dir = cache_dir.join("imgcache");
          if std::fs::create_dir_all(&dir).is_ok() {
              let _ = IMAGE_CACHE_DIR.set(dir.clone());
              tauri::async_runtime::spawn_blocking(move || prune_image_cache(&dir));
          }
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
