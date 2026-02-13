const { clipboard } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const TEMP_DIR = path.join(os.tmpdir(), "wsl-paste-image");

/** 确保临时目录存在 */
function ensureTempDir() {
    if (!fs.existsSync(TEMP_DIR)) {
        fs.mkdirSync(TEMP_DIR, { recursive: true });
    }
}

/** 清理超过 1 天的旧文件 */
function cleanOldFiles() {
    if (!fs.existsSync(TEMP_DIR)) return;
    const now = Date.now();
    try {
        for (const file of fs.readdirSync(TEMP_DIR)) {
            const fp = path.join(TEMP_DIR, file);
            if (now - fs.statSync(fp).mtimeMs > 86400000) fs.unlinkSync(fp);
        }
    } catch (_) {}
}

/** Windows 路径 → WSL 路径 */
function toWslPath(winPath) {
    const norm = winPath.replace(/\\/g, "/");
    const m = norm.match(/^([a-zA-Z]):\/(.*)$/);
    return m ? `/mnt/${m[1].toLowerCase()}/${m[2]}` : norm;
}

/** 从剪贴板读取图片，保存到临时目录，返回 WSL 路径 */
function processClipboardImage() {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;

    ensureTempDir();
    cleanOldFiles();

    const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
    const fp = path.join(TEMP_DIR, `wsl_paste_${ts}.png`);
    fs.writeFileSync(fp, img.toPNG());

    return toWslPath(fp);
}

window.exports = {
    "wsl-paste-screenshot": {
        mode: "none",
        args: {
            enter: () => {
                const wslPath = processClipboardImage();
                if (wslPath) {
                    clipboard.writeText(wslPath);
                    utools.showNotification("已复制: " + wslPath);
                } else {
                    utools.showNotification("剪贴板中没有图片，请先截图");
                }
                utools.outPlugin();
            },
        },
    },
    "wsl-paste-clipboard": {
        mode: "none",
        args: {
            enter: () => {
                const wslPath = processClipboardImage();
                if (wslPath) {
                    clipboard.writeText(wslPath);
                    utools.showNotification("已复制: " + wslPath);
                } else {
                    utools.showNotification("剪贴板中没有图片，请先截图");
                }
                utools.outPlugin();
            },
        },
    },
};
