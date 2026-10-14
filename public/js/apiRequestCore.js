/**
 * Executes an API request, using Tauri's invoke if available, otherwise falling back to fetch.
 * @param {string} apiUrl The URL to request.
 * @param {object} options Configuration for the request.
 * @param {string} [options.method="GET"] - HTTP method.
 * @param {object} [options.headers={}] - Request headers.
 * @param {number} [options.timeoutSecs=tauriConstants.TIMEOUT_SECS] - Timeout in seconds.
 * @param {string} [options.sourceForLog=''] - Source identifier for logging.
 * @returns {Promise<object>} A promise that resolves to the JSON response data.
 * @throws {Error} Throws an error if the request fails or returns invalid data.
 */
async function executeApiRequest(apiUrl, options = {}) {
    console.log(`[JS] executeApiRequest called with apiUrl: ${apiUrl}, options:`, JSON.stringify(options));
    const {
        method = "GET",
        headers = {},
        timeoutSecs = tauriConstants.TIMEOUT_SECS, // Assumes tauriConstants is globally available
        sourceForLog = '',
        asText = false // New option to expect text response
    } = options;

    const logPrefix = sourceForLog ? `(${sourceForLog}) ` : '';
    let responseData;

    const isTauriNow = isLikelyTauriEnvironment(); // Assumes isLikelyTauriEnvironment is globally available
    // console.log(`[Debug] ${logPrefix}executeApiRequest: isLikelyTauriEnvironment?`, isTauriNow, 'invoke available?', !!tauriConstants.invoke);

    if (isTauriNow && tauriConstants.invoke) {
        // console.log(`Tauri env & invoke available, using Rust command for ${logPrefix}request: ${apiUrl}`);
        const rustOptions = { 
            url: apiUrl, 
            method: method, 
            headers: headers, 
            timeout_secs: timeoutSecs,
            response_as_text: asText // Pass asText to Rust options
        };
        try {
            const rustResponse = await tauriConstants.invoke('make_http_request', { options: rustOptions });
            if (rustResponse.status >= 200 && rustResponse.status < 300) {
                if (asText) {
                    responseData = rustResponse.body; // Return raw text body
                } else {
                    const contentType = rustResponse.headers['content-type'] || rustResponse.headers['Content-Type'] || '';
                    if (contentType.includes('application/json')) {
                        responseData = JSON.parse(rustResponse.body);
                    } else {
                        // If not expecting text and not JSON, this is an issue.
                        throw createApiError(`${logPrefix}API (via invoke) returned non-JSON content-type: '${contentType}' when JSON was expected. Body: ${rustResponse.body.substring(0, 200)}`);
                    }
                }
            } else {
                throw createApiError(`${logPrefix}API (via invoke) returned error status ${rustResponse.status}. Body: ${rustResponse.body.substring(0, 200)}`, rustResponse.status);
            }
        } catch (invokeError) {
            console.error(`Tauri invoke 'make_http_request' failed for ${logPrefix}request:`, invokeError);
            let errMsg = `Tauri IPC call failed for ${logPrefix}request`;
            if (typeof invokeError === 'string') errMsg = invokeError;
            else if (invokeError && typeof invokeError === 'object' && invokeError.error) errMsg = `${invokeError.error}${invokeError.details ? ': ' + invokeError.details : ''}`;
            else if (invokeError && invokeError.message) errMsg = invokeError.message;
            const customErr = createApiError(errMsg); // Assumes createApiError is globally available
            if (invokeError && typeof invokeError === 'object' && invokeError.status) customErr.statusCode = invokeError.status;
            throw customErr;
        }
    } else {
        // console.log(`Not Tauri or invoke unavailable, falling back to fetch for ${logPrefix}request. PROXY_URL = ${proxyUrl}`);
        let controller = new AbortController();
        let timeoutId = setTimeout(() => controller.abort(), timeoutSecs * 1000);
        let fetchUrlToUse = apiUrl; // Always use direct apiUrl for fetch
        let effectiveHeaders = { ...headers }; // Create a mutable copy of headers
        // console.log(`Not Tauri or invoke unavailable, falling back to direct fetch for ${logPrefix}request: ${fetchUrlToUse}`);

        try {
            const response = await fetch(fetchUrlToUse, { headers: effectiveHeaders, signal: controller.signal, method: method });
            clearTimeout(timeoutId); timeoutId = null;

            const responseText = await response.text(); // Get text first to log it in case of error
            const contentType = response.headers.get('content-type');

            if (!response.ok) {
                let errMsg = `${logPrefix}代理服务错误: ${response.status}. URL: ${fetchUrlToUse}. Response: ${responseText.substring(0, 200)}`;
                // Try to parse error from JSON if possible, but don't rely on it
                try { 
                    const eData = JSON.parse(responseText);
                    if (eData) errMsg += eData.error ? ` - ${eData.error}` : (eData.msg ? ` - ${eData.msg}` : '');
                } catch (e) {/*ignore if not JSON*/}
                console.error(`[executeApiRequest] Fetch error: Status ${response.status}, URL: ${fetchUrlToUse}, Headers:`, response.headers, `Body chunk: ${responseText.substring(0,500)}`);
                throw createApiError(errMsg, response.status);
            }

            try {
                responseData = JSON.parse(responseText);
            } catch (parseError) {
                const errorDetails = `${logPrefix}内容解析失败. Content-Type: ${contentType}. URL: ${fetchUrlToUse}. Error: ${parseError.message}. Body chunk: ${responseText.substring(0,500)}`;
                console.error(`[executeApiRequest] JSON Parse error:`, errorDetails);
                if (!contentType || !contentType.includes('application/json')) {
                    throw createApiError(`${logPrefix}API返回的不是有效的JSON格式，且内容解析失败。接收到 Content-Type: ${contentType}. 内容: ${responseText.substring(0,100)}...`);
                }
                throw createApiError(`${logPrefix}API返回了application/json类型，但JSON内容无效。错误: ${parseError.message}. 内容: ${responseText.substring(0,100)}...`);
            }
            
            // Log if content type was not JSON but parsing succeeded (might indicate misconfigured server)
            if (contentType && !contentType.includes('application/json')) {
                console.warn(`[executeApiRequest] ${logPrefix}Response parsed as JSON, but Content-Type was '${contentType}'. URL: ${fetchUrlToUse}`);
            }

        } catch (fetchCatchError) {
            if(timeoutId) clearTimeout(timeoutId);
            console.error(`[executeApiRequest] Catch all fetch error for ${logPrefix}request to ${fetchUrlToUse}:`, fetchCatchError, `Original URL: ${apiUrl}`);
            throw fetchCatchError; // Re-throw original error to preserve its type/details
        }
    }
    return responseData;
}
