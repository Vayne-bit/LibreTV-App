// 密码保护功能

/**
 * 检查是否设置了密码保护
 * 通过读取页面上嵌入的环境变量来检查
 */
function isPasswordProtected() {
    // 检查页面上嵌入的环境变量
    const pwd = window.__ENV__ && window.__ENV__.PASSWORD;
    // 只有当密码 hash 存在且为64位（SHA-256十六进制长度）才认为启用密码保护
    return typeof pwd === 'string' && pwd.length === 64 && !/^0+$/.test(pwd);
}

/**
 * 检查用户是否已通过密码验证
 * 检查localStorage中的验证状态和时间戳是否有效，并确认密码哈希未更改
 */
function isPasswordVerified() {
    try {
        // 如果没有设置密码保护，则视为已验证
        if (!isPasswordProtected()) {
            return true;
        }

        const verificationData = JSON.parse(localStorage.getItem(PASSWORD_CONFIG.localStorageKey) || '{}');
        const { verified, timestamp, passwordHash } = verificationData;
        
        // 获取当前环境中的密码哈希
        const currentHash = window.__ENV__ && window.__ENV__.PASSWORD;
        
        // 验证是否已验证、未过期，且密码哈希未更改
        if (verified && timestamp && passwordHash === currentHash) {
            const now = Date.now();
            const expiry = timestamp + PASSWORD_CONFIG.verificationTTL;
            return now < expiry;
        }
        
        return false;
    } catch (error) {
        console.error('验证密码状态时出错:', error);
        return false;
    }
}

window.isPasswordProtected = isPasswordProtected;
window.isPasswordVerified = isPasswordVerified;

/**
 * 验证用户输入的密码是否正确（异步，使用SHA-256哈希）
 */
async function verifyPassword(password) {
    const correctHash = window.__ENV__ && window.__ENV__.PASSWORD;
    if (!correctHash) return false;
    const inputHash = await sha256(password);
    const isValid = inputHash === correctHash;
    if (isValid) {
        const verificationData = {
            verified: true,
            timestamp: Date.now(),
            passwordHash: correctHash // 保存当前密码的哈希值
        };
        localStorage.setItem(PASSWORD_CONFIG.localStorageKey, JSON.stringify(verificationData));
    }
    return isValid;
}

// SHA-256实现，可用Web Crypto API
async function sha256(message) {
    if (window.crypto && crypto.subtle && crypto.subtle.digest) {
        const msgBuffer = new TextEncoder().encode(message);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }
    // HTTP 下调用原始 js‑sha256
    if (typeof window._jsSha256 === 'function') {
        return window._jsSha256(message);
    }
    throw new Error('No SHA-256 implementation available.');
}

/**
 * 显示密码验证弹窗
 */
function showPasswordModal() {
    const passwordModal = document.getElementById('passwordModal');
    if (passwordModal) {
        passwordModal.style.display = 'flex';
        
        // 确保输入框获取焦点
        setTimeout(() => {
            const passwordInput = document.getElementById('passwordInput');
            if (passwordInput) {
                passwordInput.focus();
            }
        }, 100);
    }
}

/**
 * 隐藏密码验证弹窗
 */
function hidePasswordModal() {
    const passwordModal = document.getElementById('passwordModal');
    if (passwordModal) {
        passwordModal.style.display = 'none';
    }
}

/**
 * 显示密码错误信息
 */
function showPasswordError() {
    const errorElement = document.getElementById('passwordError');
    if (errorElement) {
        errorElement.classList.remove('hidden');
    }
}

/**
 * 隐藏密码错误信息
 */
function hidePasswordError() {
    const errorElement = document.getElementById('passwordError');
    if (errorElement) {
        errorElement.classList.add('hidden');
    }
}

/**
 * 处理密码提交事件（异步）
 */
async function handlePasswordSubmit() {
    const passwordInput = document.getElementById('passwordInput');
    const password = passwordInput ? passwordInput.value.trim() : '';
    if (await verifyPassword(password)) {
        hidePasswordError();
        hidePasswordModal();

        // 触发密码验证成功事件
        document.dispatchEvent(new CustomEvent('passwordVerified'));
    } else {
        showPasswordError();
        if (passwordInput) {
            passwordInput.value = '';
            passwordInput.focus();
        }
    }
}

/**
 * 初始化密码验证系统（需适配异步事件）
 */
function initPasswordProtection() {
    if (!isPasswordProtected()) {
        return; // 如果未设置密码保护，则不进行任何操作
    }
    
    // 如果未验证密码，则显示密码验证弹窗
    if (!isPasswordVerified()) {
        showPasswordModal();
        
        // 提交统一走表单的 onsubmit（index.html 里 passwordForm 已绑定）：
        // 按钮是 type=submit（点击即触发 submit），输入框回车也触发 submit——
        // 以前这里又给按钮和回车各挂一个监听，一次提交会跑 2~3 遍验证。
        void 0;
    }
}

// 在页面加载完成后初始化密码保护
document.addEventListener('DOMContentLoaded', initPasswordProtection);
