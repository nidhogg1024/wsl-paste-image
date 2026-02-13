const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const TEMP_DIR = path.join(os.tmpdir(), "wsl-paste-image");
const EXE_PATH = path.join(TEMP_DIR, "WslPaste.exe");
const SRC_PATH = path.join(__dirname, "WslPaste.cs");
const CONFIG_KEY = "wsl_paste_config";

// ===== 编译管理 =====

function ensureExe() {
    // 检查 exe 是否存在且比源码新
    if (fs.existsSync(EXE_PATH)) {
        const exeTime = fs.statSync(EXE_PATH).mtimeMs;
        const srcTime = fs.statSync(SRC_PATH).mtimeMs;
        if (exeTime > srcTime) return true;
    }

    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

    // 查找 csc.exe
    let csc = "";
    for (const arch of ["Framework64", "Framework"]) {
        const base = `C:\\Windows\\Microsoft.NET\\${arch}\\`;
        try {
            const dirs = fs.readdirSync(base).filter(d => d.startsWith("v")).sort().reverse();
            for (const d of dirs) {
                const p = path.join(base, d, "csc.exe");
                if (fs.existsSync(p)) { csc = p; break; }
            }
        } catch (_) {}
        if (csc) break;
    }
    if (!csc) return false;

    try {
        execSync(`"${csc}" /nologo /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /out:"${EXE_PATH}" "${SRC_PATH}"`, {
            windowsHide: true, timeout: 15000,
        });
        return fs.existsSync(EXE_PATH);
    } catch (_) { return false; }
}

// ===== 快捷键解析 =====

function hotkeyToVkCodes(hotkey) {
    const parts = hotkey.toLowerCase().split("+").map(k => k.trim());
    const vkMap = {
        "win": 0x5B, "ctrl": 0x11, "shift": 0x10, "alt": 0x12,
        "tab": 0x09, "enter": 0x0D, "space": 0x20, "esc": 0x1B,
        "backspace": 0x08, "delete": 0x2E,
        "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
        "printscreen": 0x2C, "prtsc": 0x2C,
    };
    const codes = [];
    for (const p of parts) {
        if (vkMap[p] !== undefined) codes.push(vkMap[p]);
        else if (p.length === 1) codes.push(p.toUpperCase().charCodeAt(0));
        else if (/^f(\d+)$/.test(p)) codes.push(0x6F + parseInt(p.slice(1)));
    }
    return codes;
}

// ===== 配置 =====

function getConfig() { return utools.dbStorage.getItem(CONFIG_KEY) || null; }
function setConfig(config) { utools.dbStorage.setItem(CONFIG_KEY, config); }

// ===== preload 拦截：已配置则直接执行 =====

utools.onPluginEnter(({ code }) => {
    if (code === "wsl-paste-setting") return;

    const config = getConfig();
    if (!config || !config.hotkey) return;

    if (!ensureExe()) {
        utools.showNotification("编译失败，请确认系统有 .NET Framework");
        utools.outPlugin();
        return;
    }

    utools.hideMainWindow();

    const vks = hotkeyToVkCodes(config.hotkey);
    try {
        const result = execSync(`"${EXE_PATH}" ${vks.join(" ")}`, {
            windowsHide: true,
            timeout: 20000,
            encoding: "utf-8",
        }).trim();

        if (result) {
            utools.showNotification("已复制: " + result);
        }
    } catch (e) {
        const stderr = e.stderr ? e.stderr.toString().trim() : "";
        utools.showNotification(stderr || "截图超时或已取消");
    }

    utools.outPlugin();
});

// ===== 暴露给设置页 =====

window.wslPaste = { getConfig, setConfig };
