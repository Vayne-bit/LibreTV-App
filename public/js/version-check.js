// 设置页底部显示当前版本号（来自 tauri.conf.json，云端打包时写入标签号）

async function showAppVersion() {
    let version = '';
    try {
        version = await tauriInvoke('plugin:app|version');
    } catch (e) {
        return;
    }
    if (!version) return;

    const footerText = document.querySelector('.footer p.text-gray-500.text-sm');
    if (!footerText) return;
    const versionElement = document.createElement('p');
    versionElement.className = 'text-gray-500 text-sm mt-1';
    versionElement.textContent = `版本 ${version}`;
    footerText.insertAdjacentElement('afterend', versionElement);
}

document.addEventListener('DOMContentLoaded', showAppVersion);
