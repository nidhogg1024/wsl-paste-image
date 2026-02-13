const { clipboard, nativeImage } = require("electron");
const { execSync, execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ===== 工具函数 =====

/** 临时文件目录 */
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
    const maxAge = 24 * 60 * 60 * 1000;
    try {
        for (const file of fs.readdirSync(TEMP_DIR)) {
            const fp = path.join(TEMP_DIR, file);
            if (now - fs.statSync(fp).mtimeMs > maxAge) fs.unlinkSync(fp);
        }
    } catch (_) {}
}

/** Windows 路径 → WSL 路径 */
function toWslPath(winPath) {
    const norm = winPath.replace(/\\/g, "/");
    const m = norm.match(/^([a-zA-Z]):\/(.*)$/);
    return m ? `/mnt/${m[1].toLowerCase()}/${m[2]}` : norm;
}

/** 生成带时间戳的文件名 */
function genFileName() {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
    return `wsl_paste_${ts}.png`;
}

/** 检测截图工具，返回 { path, args } 或 null */
function detectTool() {
    const tools = [
        { name: "PixPin", exe: "PixPin.exe", dirs: [process.env.LOCALAPPDATA, process.env.PROGRAMFILES], args: ["screenshot"] },
        { name: "Snipaste", exe: "Snipaste.exe", dirs: [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"]], args: ["snip"] },
        { name: "ShareX", exe: "ShareX.exe", dirs: [process.env.LOCALAPPDATA, process.env.PROGRAMFILES], args: ["-RectangleRegion"] },
    ];
    for (const t of tools) {
        // 检查常见安装路径
        for (const dir of t.dirs) {
            if (!dir) continue;
            const p = path.join(dir, t.name, t.exe);
            if (fs.existsSync(p)) return { path: p, args: t.args, name: t.name };
        }
        // 检查 PATH
        try {
            const r = execSync(`where ${t.exe}`, { encoding: "utf-8", timeout: 2000, windowsHide: true }).trim();
            if (r) return { path: r.split("\n")[0].trim(), args: t.args, name: t.name };
        } catch (_) {}
    }
    return null;
}

/** 调用截图工具（阻塞等待截图完成） */
function callScreenshot() {
    const tool = detectTool();
    if (tool) {
        // 第三方截图工具：非阻塞启动
        execFile(tool.path, tool.args, { windowsHide: true });
    } else {
        // 系统截图工具
        try {
            execSync("snippingtool /clip", { windowsHide: true, timeout: 1000 });
        } catch (_) {
            execSync("start ms-screenclip:", { shell: true, windowsHide: true, timeout: 1000 });
        }
    }
}

/** 从剪贴板保存图片，返回 Windows 路径或 null */
function saveClipboardImage() {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    ensureTempDir();
    const fp = path.join(TEMP_DIR, genFileName());
    fs.writeFileSync(fp, img.toPNG());
    return fp;
}

/** 等待剪贴板出现新图片（轮询），返回 Promise<boolean> */
function waitForNewImage(timeoutMs = 15000) {
    return new Promise((resolve) => {
        // 记录当前剪贴板图片的 dataURL 用于比对
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

// ===== uTools 入口 =====

window.exports = {
    "wsl-paste-screenshot": {
        mode: "none",
        args: {
            enter: async ({ code }) => {
                cleanOldFiles();

                // 1. 调用截图工具
                callScreenshot();

                // 2. 等待新截图进入剪贴板
                const hasNew = await waitForNewImage(15000);
                if (!hasNew) {
                    utools.showNotification("截图超时或已取消");
                    utools.outPlugin();
                    return;
                }

                // 3. 保存图片 + 转路径 + 写剪贴板
                const winPath = saveClipboardImage();
                if (!winPath) {
                    utools.showNotification("剪贴板中没有图片");
                    utools.outPlugin();
                    return;
                }
                const wslPath = toWslPath(winPath);
                clipboard.writeText(wslPath);
                utools.showNotification(`已复制: ${wslPath}`);
                utools.outPlugin();
            },
        },
    },
    "wsl-paste-clipboard": {
        mode: "none",
        args: {
            enter: ({ code }) => {
                cleanOldFiles();

                const winPath = saveClipboardImage();
                if (!winPath) {
                    utools.showNotification("剪贴板中没有图片");
                    utools.outPlugin();
                    return;
                }
                const wslPath = toWslPath(winPath);
                clipboard.writeText(wslPath);
                utools.showNotification(`已复制: ${wslPath}`);
                utools.outPlugin();
            },
        },
    },
};
