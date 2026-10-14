// Broader Tauri environment detection
function isLikelyTauriEnvironment() {
    if (typeof window !== 'undefined') {
        // Log individual checks for better debugging
        // console.log('[EnvCheck] window.__TAURI_IPC__:', !!window.__TAURI_IPC__);
        // console.log('[EnvCheck] window.__TAURI_METADATA__:', !!window.__TAURI_METADATA__);
        // console.log('[EnvCheck] window.__TAURI__:', !!window.__TAURI__);
        // console.log('[EnvCheck] window.location.protocol:', window.location.protocol);
        // console.log('[EnvCheck] window.location.hostname:', window.location.hostname);
        // console.log('[EnvCheck] navigator.userAgent:', navigator.userAgent);

        if (!!window.__TAURI_IPC__ || !!window.__TAURI_METADATA__ || !!window.__TAURI__) return true;
        if (window.location.protocol === 'tauri:') return true;
        if (window.location.hostname === 'tauri.localhost') return true; 
        if (navigator.userAgent.includes("Tauri")) return true;
    }
    return false;
}

const tauriConstants = {
    get invoke() {
        if (typeof window !== 'undefined') {
            // Tauri v2+
            if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function') {
                return window.__TAURI_INTERNALS__.invoke;
            }
            // Fallback for older Tauri versions or other structures if window.__TAURI__ is used
            if (window.__TAURI__ && typeof window.__TAURI__ === 'object') {
                if (typeof window.__TAURI__.invoke === 'function') { // Direct invoke on __TAURI__
                    return window.__TAURI__.invoke;
                }
                if (window.__TAURI__.core && typeof window.__TAURI__.core.invoke === 'function') { // v1 style
                    return window.__TAURI__.core.invoke;
                }
                if (window.__TAURI__.tauri && typeof window.__TAURI__.tauri.invoke === 'function') { // another v1 style
                    return window.__TAURI__.tauri.invoke;
                }
            }
        }
        return null;
    },
    TIMEOUT_SECS: 20, // Default timeout for Rust HTTP client & JS fetch fallback
};

// Helper for error construction
const createApiError = (message, statusCode) => {
    const err = new Error(message);
    if (statusCode) err.statusCode = statusCode;
    return err;
};
