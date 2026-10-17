// Function to initialize the application after Tauri APIs are ready
function initializeApp() {
    if (!localStorage.getItem('hasInitializedDefaults')) {
        selectedAPIs = ["tyyszy", "xiaomaomi", "bfzy", "dyttzy", "ruyi"];
        localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs));
        localStorage.setItem('yellowFilterEnabled', 'true');
        localStorage.setItem(PLAYER_CONFIG.adFilteringStorage, 'true');
        localStorage.setItem('doubanEnabled', 'true');
        localStorage.setItem('hasInitializedDefaults', 'true');
    }

    initAPICheckboxes();
    renderCustomAPIsList();
    updateSelectedApiCount();
    renderSearchHistory();

    const yellowFilterToggle = document.getElementById('yellowFilterToggle');
    if (yellowFilterToggle) yellowFilterToggle.checked = localStorage.getItem('yellowFilterEnabled') === 'true';

    const adFilterToggle = document.getElementById('adFilterToggle');
    if (adFilterToggle) adFilterToggle.checked = localStorage.getItem(PLAYER_CONFIG.adFilteringStorage) !== 'false';

    const doubanToggle = document.getElementById('doubanToggle');
    if (doubanToggle) doubanToggle.checked = localStorage.getItem('doubanEnabled') !== 'false';

    setupEventListeners();
    setTimeout(checkAdultAPIsSelected, 100);

    initAppShell();
    if (typeof scheduleSourceHealthCheck === 'function') scheduleSourceHealthCheck();
}

// Wait for Tauri API to be ready before initializing the app
function whenTauriApiReady(callback) {
    // Check if tauriConstants and its invoke method are available
    // tauriConstants is defined in apiUtils.js and should be loaded before app.js
    if (typeof tauriConstants !== 'undefined' && tauriConstants.invoke) {
        console.log("[AppInit] Tauri API (via tauriConstants.invoke) is immediately available.");
        callback();
    } else {
        let attempts = 0;
        const maxAttempts = 100; // Reverted to 10 seconds timeout
        const intervalTime = 100; // Check every 100ms
        console.log("[AppInit] Tauri API (via tauriConstants.invoke) not immediately available. Starting polling...");
        const interval = setInterval(() => {
            attempts++;
            // Simplified logging, closer to what might have been original or less intrusive
            if (attempts === 1 || attempts % 50 === 0 || attempts === maxAttempts) { // Log less frequently
                console.log(`[AppInit Polling Attempt ${attempts}] Checking for tauriConstants.invoke...`);
                if (typeof tauriConstants !== 'undefined' && tauriConstants.invoke) {
                     console.log(`[AppInit Polling Attempt ${attempts}] tauriConstants.invoke is now available.`);
                } else {
                     console.log(`[AppInit Polling Attempt ${attempts}] tauriConstants.invoke is still NOT available.`);
                }
            }

            if (typeof tauriConstants !== 'undefined' && tauriConstants.invoke) {
                clearInterval(interval);
                console.log(`[AppInit] Tauri API (via tauriConstants.invoke) became available after ${attempts} attempts.`);
                callback();
            } else if (attempts >= maxAttempts) {
                clearInterval(interval);
                console.error("[AppInit] Tauri API (via tauriConstants.invoke) did not become available after " + (maxAttempts * intervalTime / 1000) + " seconds. App might not function correctly.");
                callback(); 
            }
        }, intervalTime);
    }
}

// 页面初始化
document.addEventListener('DOMContentLoaded', function() {
    console.log("[AppInit] DOMContentLoaded event fired.");
    whenTauriApiReady(initializeApp);
});
