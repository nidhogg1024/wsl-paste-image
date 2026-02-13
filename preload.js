const { clipboard } = require("electron");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const TEMP_DIR = path.join(os.tmpdir(), "wsl-paste-image");
const CONFIG_KEY = "wsl_paste_config";

// ===== 工具函数 =====

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

function saveClipboardImage() {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    ensureTempDir();
    const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
    const fp = path.join(TEMP_DIR, `wsl_paste_${ts}.png`);
    fs.writeFileSync(fp, img.toPNG());
    return fp;
}

/**
 * 通过 PowerShell 模拟按键
 * hotkey 格式示例: "ctrl+shift+x", "f1", "win+shift+s"
 */
function simulateHotkey(hotkey) {
    // 转换为 PowerShell SendKeys 格式
    const keyMap = {
        "ctrl": "^",
        "shift": "+",
        "alt": "%",
        "win": "^{ESC}",  // 特殊处理
    };

    let parts = hotkey.toLowerCase().split("+").map(k => k.trim());
    let psKeys = "";

    // 检查是否包含 win 键 — 用特殊方式处理
    if (parts.includes("win")) {
        // Win 组合键用 PowerShell 的专用方法
        const nonWin = parts.filter(k => k !== "win");
        const modifiers = [];
        const keys = [];
        for (const p of nonWin) {
            if (p === "ctrl") modifiers.push("^");
            else if (p === "shift") modifiers.push("+");
            else if (p === "alt") modifiers.push("%");
            else if (p.length === 1) keys.push(p.toUpperCase());
            else keys.push(`{${p.toUpperCase()}}`);
        }
        // Win+Shift+S 等系统快捷键用 keybd_event
        const vkCodes = [];
        if (parts.includes("win")) vkCodes.push("0x5B"); // VK_LWIN
        if (parts.includes("ctrl")) vkCodes.push("0x11");
        if (parts.includes("shift")) vkCodes.push("0x10");
        if (parts.includes("alt")) vkCodes.push("0x12");
        // 最后一个非修饰键
        const mainKey = nonWin.find(k => !["ctrl", "shift", "alt"].includes(k));
        if (mainKey) {
            if (mainKey.length === 1) {
                vkCodes.push(`0x${mainKey.toUpperCase().charCodeAt(0).toString(16)}`);
            } else if (mainKey.startsWith("f") && !isNaN(mainKey.slice(1))) {
                // F1-F12
                vkCodes.push(`0x${(0x6F + parseInt(mainKey.slice(1))).toString(16)}`);
            }
        }
        // PowerShell keybd_event 脚本
        const downCmds = vkCodes.map(vk => `[Win32]::keybd_event(${vk}, 0, 0, 0)`).join("; ");
        const upCmds = vkCodes.reverse().map(vk => `[Win32]::keybd_event(${vk}, 0, 2, 0)`).join("; ");
        const ps = `
            Add-Type @"
                using System;
                using System.Runtime.InteropServices;
                public class Win32 {
                    [DllImport("user32.dll")]
                    public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);
                }
"@
            ${downCmds}; Start-Sleep -Milliseconds 50; ${upCmds}
        `;
        try {
            execSync(`powershell -NoProfile -Command "${ps.replace(/\n/g, " ").replace(/"/g, '\\"')}"`, {
                windowsHide: true,
                timeout: 5000,
            });
        } catch (_) {}
        return;
    }

    // 非 Win 组合键用 SendKeys
    for (const p of parts) {
        if (keyMap[p]) {
            psKeys += keyMap[p];
        } else if (p.length === 1) {
            psKeys += p;
        } else if (p.startsWith("f") && !isNaN(p.slice(1))) {
            psKeys += `{${p.toUpperCase()}}`;
        } else {
            psKeys += `{${p.toUpperCase()}}`;
        }
    }

    try {
        execSync(
            `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${psKeys}')"`,
            { windowsHide: true, timeout: 5000 }
        );
    } catch (_) {}
}

/** 等待剪贴板出现新图片 */
function waitForNewImage(timeoutMs) {
    return new Promise((resolve) => {
        const oldImg = clipboard.readImage();
        const oldData = oldImg.isEmpty() ? "" : oldImg.toDataURL().slice(0, 200);
        let elapsed = 0;
        const interval = 300;
        const timer = setInterval(() => {
            elapsed += interval;
            const cur = clipboard.readImage();
            if (!cur.isEmpty()) {
                const curData = cur.toDataURL().slice(0, 200);
                if (curData !== oldData) {
                    clearInterval(timer);
                    resolve(true);
                    return;
                }
            }
            if (elapsed >= timeoutMs) {
                clearInterval(timer);
                resolve(false);
            }
        }, interval);
    });
}

// ===== 配置管理 =====

function getConfig() {
    const data = utools.dbStorage.getItem(CONFIG_KEY);
    return data || null;
}

function setConfig(config) {
    utools.dbStorage.setItem(CONFIG_KEY, config);
}

// ===== 暴露给页面 =====

window.wslPaste = {
    getConfig,
    setConfig,
    simulateHotkey,
    waitForNewImage,
    saveClipboardImage,
    toWslPath,
    cleanOldFiles,
    clipboard,
};
