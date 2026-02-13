const { clipboard } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const TEMP_DIR = path.join(os.tmpdir(), "wsl-paste-image");

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

/**
 * 获取剪贴板当前状态的"指纹"（用于检测变化）
 * 用图片尺寸比较，几乎零开销
 */
function getClipboardFingerprint() {
    try {
        const img = clipboard.readImage();
        if (!img.isEmpty()) {
            const size = img.getSize();
            return `img:${size.width}x${size.height}`;
        }
    } catch (_) {}
    return "empty";
}

/**
 * 带重试的剪贴板读取（剪贴板可能被其他程序锁定）
 * 返回 { type: "image", image } | { type: "file", path } | null
 */
function readClipboardWithRetry(maxRetries = 5) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            // 优先检查文件拖放（从资源管理器复制的文件）
            // uTools/Electron 中读取文件列表
            const text = clipboard.readText();
            if (text && fs.existsSync(text.trim()) && /\.(png|jpg|jpeg|gif|bmp|webp)$/i.test(text.trim())) {
                return { type: "file", path: text.trim() };
            }

            // 检查图片
            const img = clipboard.readImage();
            if (img && !img.isEmpty()) {
                return { type: "image", image: img };
            }
        } catch (_) {
            // 剪贴板忙，等待后重试
        }
        if (i < maxRetries - 1) {
            const start = Date.now();
            while (Date.now() - start < 100) {} // 同步等待 100ms
        }
    }
    return null;
}

/**
 * 处理剪贴板内容 → 返回 WSL 路径（带单引号）
 * 支持图片和文件两种类型
 */
function processClipboard() {
    const data = readClipboardWithRetry();
    if (!data) return null;

    let winPath;

    if (data.type === "file") {
        // 剪贴板是文件路径，直接使用
        winPath = data.path;
    } else {
        // 剪贴板是图片，保存到临时目录
        ensureTempDir();
        const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
        winPath = path.join(TEMP_DIR, `wsl_shot_${ts}.png`);
        fs.writeFileSync(winPath, data.image.toPNG());
    }

    // 转 WSL 路径，用单引号包裹（防止空格等特殊字符）
    return `'${toWslPath(winPath)}'`;
}

/**
 * 检测 Esc 键是否被按下（通过 GetAsyncKeyState）
 */
function isEscPressed() {
    try {
        const result = execSync(
            'powershell -NoProfile -Command "[Console]::Write([System.Windows.Forms.Control]::ModifierKeys -eq \'None\' -and [System.Windows.Forms.NativeWindow]); Add-Type -AssemblyName System.Windows.Forms; [Console]::Write(([System.Windows.Forms.Form+NativeMethods]::GetAsyncKeyState(0x1B) -band 0x8000) -ne 0)"',
            { windowsHide: true, timeout: 500, encoding: "utf-8" }
        ).trim();
        return result === "True";
    } catch (_) {
        // 备选：直接用简短的 C# 调用
        try {
            const ps = Buffer.from(
                'Add-Type -MemberDefinition \'[DllImport("user32.dll")]public static extern short GetAsyncKeyState(int vKey);\' -Name K -Namespace W;if(([W.K]::GetAsyncKeyState(0x1B) -band 0x8000) -ne 0){Write-Output 1}else{Write-Output 0}',
                "utf16le"
            ).toString("base64");
            const r = execSync(`powershell -NoProfile -EncodedCommand ${ps}`, {
                windowsHide: true, timeout: 500, encoding: "utf-8"
            }).trim();
            return r === "1";
        } catch (_) {
            return false;
        }
    }
}

/**
 * 等待剪贴板出现新图片（通过尺寸指纹比对）
 * 同时监听 Esc 键，按下则立即取消
 */
function waitForNewImage(oldFingerprint, timeoutMs) {
    return new Promise((resolve) => {
        let elapsed = 0;
        const interval = 200;
        const timer = setInterval(() => {
            elapsed += interval;
            // 检测剪贴板变化
            const cur = getClipboardFingerprint();
            if (cur !== "empty" && cur !== oldFingerprint) {
                clearInterval(timer);
                resolve("ok");
                return;
            }
            // 每 600ms 检测一次 Esc（PowerShell 调用有开销，不要太频繁）
            if (elapsed % 600 < interval) {
                if (isEscPressed()) {
                    clearInterval(timer);
                    resolve("cancelled");
                    return;
                }
            }
            if (elapsed >= timeoutMs) {
                clearInterval(timer);
                resolve("timeout");
            }
        }, interval);
    });
}

// ===== 配置 =====

const CONFIG_KEY = "wsl_paste_config";

function getConfig() {
    return utools.dbStorage.getItem(CONFIG_KEY) || null;
}

function setConfig(config) {
    utools.dbStorage.setItem(CONFIG_KEY, config);
}

// ===== 模拟快捷键 =====

const { execSync } = require("child_process");

function simulateHotkey(hotkey) {
    const parts = hotkey.toLowerCase().split("+").map(k => k.trim());

    const vkMap = {
        "win": 0x5B, "ctrl": 0x11, "shift": 0x10, "alt": 0x12,
        "tab": 0x09, "enter": 0x0D, "space": 0x20, "esc": 0x1B,
        "backspace": 0x08, "delete": 0x2E, "insert": 0x2D,
        "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
        "printscreen": 0x2C, "prtsc": 0x2C,
    };

    const vkCodes = [];
    for (const p of parts) {
        if (vkMap[p] !== undefined) {
            vkCodes.push(vkMap[p]);
        } else if (p.length === 1) {
            vkCodes.push(p.toUpperCase().charCodeAt(0));
        } else if (/^f(\d+)$/.test(p)) {
            vkCodes.push(0x6F + parseInt(p.slice(1)));
        }
    }
    if (vkCodes.length === 0) return;

    // 构建 PowerShell 脚本，用 -EncodedCommand 避免引号问题
    const lines = [
        'Add-Type -TypeDefinition @"',
        'using System;',
        'using System.Runtime.InteropServices;',
        'public class KeySim {',
        '  [DllImport("user32.dll")]',
        '  public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);',
        '}',
        '"@',
        ...vkCodes.map(vk => `[KeySim]::keybd_event(${vk}, 0, 0, 0)`),
        'Start-Sleep -Milliseconds 50',
        ...vkCodes.slice().reverse().map(vk => `[KeySim]::keybd_event(${vk}, 0, 2, 0)`),
    ];
    const script = lines.join("\r\n");
    // Base64 编码（UTF-16LE，PowerShell 要求）
    const encoded = Buffer.from(script, "utf16le").toString("base64");

    try {
        execSync(`powershell -NoProfile -EncodedCommand ${encoded}`, { windowsHide: true, timeout: 5000 });
    } catch (_) {}
}

// ===== 暴露 =====

window.wslPaste = {
    getConfig,
    setConfig,
    simulateHotkey,
    getClipboardFingerprint,
    waitForNewImage,
    processClipboard,
    cleanOldFiles,
    clipboard,
};
