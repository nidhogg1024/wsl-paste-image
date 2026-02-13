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

// ===== 快捷键模拟（编译 C# 小程序调用 keybd_event，首次编译后缓存） =====

const KEYSIM_DIR = path.join(os.tmpdir(), "wsl-paste-image");
const KEYSIM_EXE = path.join(KEYSIM_DIR, "keysim.exe");
const KEYSIM_SRC = path.join(KEYSIM_DIR, "keysim.cs");

const KEYSIM_CODE = `
using System;
using System.Runtime.InteropServices;
using System.Threading;
class K {
    [DllImport("user32.dll")]
    static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);
    static void Main(string[] args) {
        byte[] vks = new byte[args.Length];
        for (int i = 0; i < args.Length; i++) vks[i] = byte.Parse(args[i]);
        foreach (var vk in vks) keybd_event(vk, 0, 0, 0);
        Thread.Sleep(50);
        for (int i = vks.Length - 1; i >= 0; i--) keybd_event(vks[i], 0, 2, 0);
    }
}
`.trim();

/** 确保 keysim.exe 存在（首次编译，后续直接用缓存） */
function ensureKeysimExe() {
    if (fs.existsSync(KEYSIM_EXE)) return true;
    ensureTempDir();
    fs.writeFileSync(KEYSIM_SRC, KEYSIM_CODE);
    // 查找 csc.exe（.NET Framework 自带，Windows 都有）
    const fwDir = "C:\\Windows\\Microsoft.NET\\Framework64\\";
    let csc = "";
    try {
        const dirs = fs.readdirSync(fwDir).filter(d => d.startsWith("v")).sort().reverse();
        for (const d of dirs) {
            const p = path.join(fwDir, d, "csc.exe");
            if (fs.existsSync(p)) { csc = p; break; }
        }
    } catch (_) {}
    if (!csc) {
        // 尝试 32 位
        const fwDir32 = "C:\\Windows\\Microsoft.NET\\Framework\\";
        try {
            const dirs = fs.readdirSync(fwDir32).filter(d => d.startsWith("v")).sort().reverse();
            for (const d of dirs) {
                const p = path.join(fwDir32, d, "csc.exe");
                if (fs.existsSync(p)) { csc = p; break; }
            }
        } catch (_) {}
    }
    if (!csc) return false;
    try {
        execSync(`"${csc}" /nologo /out:"${KEYSIM_EXE}" "${KEYSIM_SRC}"`, { windowsHide: true, timeout: 10000 });
        return fs.existsSync(KEYSIM_EXE);
    } catch (_) { return false; }
}

function simulateHotkey(hotkey) {
    const parts = hotkey.toLowerCase().split("+").map(k => k.trim());

    // Win+Shift+S 特殊处理
    if (parts.includes("win") && parts.includes("shift") && parts.includes("s")) {
        try { execSync("start ms-screenclip:", { shell: true, windowsHide: true, timeout: 2000 }); } catch (_) {}
        return;
    }

    const vkMap = {
        "win": 0x5B, "ctrl": 0x11, "shift": 0x10, "alt": 0x12,
        "tab": 0x09, "enter": 0x0D, "space": 0x20, "esc": 0x1B,
        "backspace": 0x08, "delete": 0x2E,
        "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
        "printscreen": 0x2C, "prtsc": 0x2C,
    };

    const vkCodes = [];
    for (const p of parts) {
        if (vkMap[p] !== undefined) vkCodes.push(vkMap[p]);
        else if (p.length === 1) vkCodes.push(p.toUpperCase().charCodeAt(0));
        else if (/^f(\d+)$/.test(p)) vkCodes.push(0x6F + parseInt(p.slice(1)));
    }
    if (vkCodes.length === 0) return;

    if (ensureKeysimExe()) {
        // 用编译好的 keysim.exe（<10ms）
        try {
            execSync(`"${KEYSIM_EXE}" ${vkCodes.join(" ")}`, { windowsHide: true, timeout: 2000 });
        } catch (_) {}
    }
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

// ===== 在 preload 中拦截：已配置则直接执行，不等 HTML 加载 =====

utools.onPluginEnter(async ({ code }) => {
    if (code === "wsl-paste-setting") return; // 设置页走 HTML

    const config = getConfig();
    if (!config || !config.hotkey) return; // 未配置走 HTML 设置页

    // 已配置：纯 preload 执行，HTML 不渲染
    utools.hideMainWindow();
    cleanOldFiles();

    const oldFp = getClipboardFingerprint();
    await new Promise(r => setTimeout(r, 50));
    simulateHotkey(config.hotkey);

    const result = await waitForNewImage(oldFp, 10000);
    if (result !== "ok") {
        utools.showNotification("截图超时或已取消");
        utools.outPlugin();
        return;
    }

    const wslPath = processClipboard();
    if (!wslPath) {
        utools.showNotification("剪贴板中没有图片");
        utools.outPlugin();
        return;
    }

    clipboard.writeText(wslPath);
    utools.showNotification("已复制: " + wslPath);
    utools.outPlugin();
});

// ===== 暴露给设置页 HTML =====

window.wslPaste = {
    getConfig, setConfig, clipboard,
};
