const { clipboard } = require("electron");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const TEMP_DIR = path.join(os.tmpdir(), "wsl-paste-image");
const CONFIG_KEY = "wsl_paste_config";

// ===== 基础工具 =====

function ensureTempDir() {
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function cleanOldFiles() {
    if (!fs.existsSync(TEMP_DIR)) return;
    const now = Date.now();
    try {
        for (const f of fs.readdirSync(TEMP_DIR)) {
            const fp = path.join(TEMP_DIR, f);
            if (now - fs.statSync(fp).mtimeMs > 86400000) fs.unlinkSync(fp);
        }
    } catch (_) {}
}

function toWslPath(winPath) {
    const norm = winPath.replace(/\\/g, "/");
    const m = norm.match(/^([a-zA-Z]):\/(.*)$/);
    return m ? `/mnt/${m[1].toLowerCase()}/${m[2]}` : norm;
}

// ===== 剪贴板操作 =====

function getClipboardFingerprint() {
    try {
        const img = clipboard.readImage();
        if (!img.isEmpty()) {
            const s = img.getSize();
            return `${s.width}x${s.height}`;
        }
    } catch (_) {}
    return "";
}

function readClipboardWithRetry(maxRetries = 5) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const img = clipboard.readImage();
            if (img && !img.isEmpty()) {
                return { type: "image", image: img };
            }
        } catch (_) {}
        if (i < maxRetries - 1) {
            const t = Date.now(); while (Date.now() - t < 80) {}
        }
    }
    return null;
}

function processClipboard() {
    const data = readClipboardWithRetry();
    if (!data) return null;

    ensureTempDir();
    const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
    const winPath = path.join(TEMP_DIR, `wsl_shot_${ts}.png`);
    fs.writeFileSync(winPath, data.image.toPNG());

    return `'${toWslPath(winPath)}'`;
}

// ===== 快捷键模拟（VBScript，极快） =====

/**
 * 将 hotkey 字符串转为 VBScript SendKeys 格式
 * ctrl+shift+x → ^+x
 * ctrl+1 → ^1
 * f1 → {F1}
 * alt+a → %a
 */
function toSendKeysFormat(hotkey) {
    const parts = hotkey.toLowerCase().split("+").map(k => k.trim());
    let prefix = "";
    let key = "";

    for (const p of parts) {
        if (p === "ctrl") prefix += "^";
        else if (p === "shift") prefix += "+";
        else if (p === "alt") prefix += "%";
        else if (/^f(\d+)$/.test(p)) key = `{${p.toUpperCase()}}`;
        else if (p === "esc") key = "{ESC}";
        else if (p === "enter") key = "{ENTER}";
        else if (p === "tab") key = "{TAB}";
        else if (p === "space") key = " ";
        else if (p === "delete") key = "{DEL}";
        else key = p;
    }

    return prefix + key;
}

function simulateHotkey(hotkey) {
    const parts = hotkey.toLowerCase().split("+").map(k => k.trim());

    // Win 组合键特殊处理
    if (parts.includes("win")) {
        if (parts.includes("shift") && parts.includes("s")) {
            // Win+Shift+S → 系统截图，用协议调起（最快）
            try { execSync("start ms-screenclip:", { shell: true, windowsHide: true, timeout: 2000 }); } catch (_) {}
            return;
        }
        // 其他 Win 组合键用 PowerShell（不常见，可接受慢一点）
        const vkCodes = [];
        const vkMap = { "win": 0x5B, "ctrl": 0x11, "shift": 0x10, "alt": 0x12 };
        for (const p of parts) {
            if (vkMap[p]) vkCodes.push(vkMap[p]);
            else if (p.length === 1) vkCodes.push(p.toUpperCase().charCodeAt(0));
            else if (/^f(\d+)$/.test(p)) vkCodes.push(0x6F + parseInt(p.slice(1)));
        }
        const lines = [
            'Add-Type -TypeDefinition @"',
            'using System;using System.Runtime.InteropServices;',
            'public class K{[DllImport("user32.dll")]public static extern void keybd_event(byte a,byte b,int c,int d);}',
            '"@',
            ...vkCodes.map(v => `[K]::keybd_event(${v},0,0,0)`),
            'Start-Sleep -m 50',
            ...vkCodes.reverse().map(v => `[K]::keybd_event(${v},0,2,0)`),
        ];
        const enc = Buffer.from(lines.join("\r\n"), "utf16le").toString("base64");
        try { execSync(`powershell -NoProfile -EncodedCommand ${enc}`, { windowsHide: true, timeout: 5000 }); } catch (_) {}
        return;
    }

    // 非 Win 组合键：用 VBScript（mshta 内联，<50ms）
    const sendKeys = toSendKeysFormat(hotkey);
    const vbs = `CreateObject("WScript.Shell").SendKeys "${sendKeys}"`;
    try {
        execSync(`mshta vbscript:Execute("${vbs.replace(/"/g, '""')}:Close")`, {
            windowsHide: true, timeout: 2000,
        });
    } catch (_) {}
}

// ===== 等待截图 =====

function waitForNewImage(oldFingerprint, timeoutMs) {
    return new Promise((resolve) => {
        let elapsed = 0;
        const interval = 150;
        const timer = setInterval(() => {
            elapsed += interval;
            const cur = getClipboardFingerprint();
            if (cur && cur !== oldFingerprint) {
                clearInterval(timer);
                resolve("ok");
                return;
            }
            if (elapsed >= timeoutMs) {
                clearInterval(timer);
                resolve("timeout");
            }
        }, interval);
    });
}

// ===== 配置 =====

function getConfig() { return utools.dbStorage.getItem(CONFIG_KEY) || null; }
function setConfig(config) { utools.dbStorage.setItem(CONFIG_KEY, config); }

// ===== 暴露给页面 =====

window.wslPaste = {
    getConfig, setConfig, simulateHotkey,
    getClipboardFingerprint, waitForNewImage,
    processClipboard, cleanOldFiles, clipboard,
};
