const { clipboard, nativeImage } = require("electron");
const { execSync, exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

/**
 * 检测已安装的截图工具
 * 优先级：PixPin > Snipaste > ShareX > 系统自带
 */
function detectScreenshotTool() {
    const tools = [
        {
            name: "PixPin",
            // PixPin 默认安装路径
            paths: [
                path.join(process.env.LOCALAPPDATA || "", "PixPin", "PixPin.exe"),
                path.join(process.env.PROGRAMFILES || "", "PixPin", "PixPin.exe"),
            ],
            // PixPin 截图命令行参数
            args: ["screenshot"],
        },
        {
            name: "Snipaste",
            paths: [
                path.join(process.env.LOCALAPPDATA || "", "Snipaste", "Snipaste.exe"),
                path.join(process.env.PROGRAMFILES || "", "Snipaste", "Snipaste.exe"),
                path.join(process.env["PROGRAMFILES(X86)"] || "", "Snipaste", "Snipaste.exe"),
            ],
            args: ["snip"],
        },
        {
            name: "ShareX",
            paths: [
                path.join(process.env.LOCALAPPDATA || "", "ShareX", "ShareX.exe"),
                path.join(process.env.PROGRAMFILES || "", "ShareX", "ShareX.exe"),
            ],
            args: ["-RectangleRegion"],
        },
    ];

    for (const tool of tools) {
        for (const p of tool.paths) {
            if (fs.existsSync(p)) {
                return { name: tool.name, path: p, args: tool.args };
            }
        }
        // 也尝试通过 where 命令查找（在 PATH 中的情况）
        try {
            const result = execSync(`where ${tool.name}`, { encoding: "utf-8", timeout: 3000 }).trim();
            if (result) {
                return { name: tool.name, path: result.split("\n")[0].trim(), args: tool.args };
            }
        } catch (_) {
            // 未找到，继续
        }
    }

    return null;
}

/**
 * 调用截图工具
 * 返回 Promise，截图完成后 resolve
 */
function takeScreenshot() {
    return new Promise((resolve, reject) => {
        const tool = detectScreenshotTool();

        if (tool) {
            console.log(`使用 ${tool.name} 截图`);
            // 调用第三方截图工具
            const child = exec(`"${tool.path}" ${tool.args.join(" ")}`, { timeout: 30000 });
            // 等待一小段时间让截图工具启动，然后轮询剪贴板
            resolve({ tool: tool.name, method: "third-party" });
        } else {
            console.log("使用系统截图工具");
            // 调用 Windows 自带截图工具（Win+Shift+S 效果）
            try {
                exec("snippingtool /clip", { timeout: 30000 });
                resolve({ tool: "SnippingTool", method: "system" });
            } catch (e) {
                // 备选：ms-screenclip 协议
                exec('start ms-screenclip:', { timeout: 30000 });
                resolve({ tool: "ScreenClip", method: "system" });
            }
        }
    });
}

/**
 * 从剪贴板读取图片并保存到临时目录
 * 返回保存的文件路径（Windows 格式）
 */
function saveClipboardImage() {
    const img = clipboard.readImage();
    if (img.isEmpty()) {
        return null;
    }

    const pngBuffer = img.toPNG();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
    const fileName = `wsl_paste_${timestamp}.png`;
    const tempDir = path.join(os.tmpdir(), "wsl-paste-image");

    // 确保目录存在
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }

    const filePath = path.join(tempDir, fileName);
    fs.writeFileSync(filePath, pngBuffer);

    return filePath;
}

/**
 * Windows 路径转 WSL 路径
 * C:\Users\xxx\file.png → /mnt/c/Users/xxx/file.png
 */
function windowsToWslPath(winPath) {
    // 处理盘符：C:\ → /mnt/c/
    const normalized = winPath.replace(/\\/g, "/");
    const match = normalized.match(/^([a-zA-Z]):\/(.*)$/);
    if (match) {
        const drive = match[1].toLowerCase();
        const rest = match[2];
        return `/mnt/${drive}/${rest}`;
    }
    // 如果不是标准 Windows 路径，原样返回
    return normalized;
}

/**
 * 清理过期的临时文件（超过 1 天的）
 */
function cleanOldFiles() {
    const tempDir = path.join(os.tmpdir(), "wsl-paste-image");
    if (!fs.existsSync(tempDir)) return;

    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 1 天

    try {
        const files = fs.readdirSync(tempDir);
        for (const file of files) {
            const filePath = path.join(tempDir, file);
            const stat = fs.statSync(filePath);
            if (now - stat.mtimeMs > maxAge) {
                fs.unlinkSync(filePath);
            }
        }
    } catch (_) {
        // 忽略清理错误
    }
}

// 暴露给页面
window.wslPaste = {
    takeScreenshot,
    saveClipboardImage,
    windowsToWslPath,
    cleanOldFiles,
    detectScreenshotTool,
    clipboard,
};
