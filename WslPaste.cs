using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

/// <summary>
/// WSL 贴图助手 - 核心逻辑
/// 用法: WslPaste.exe <hotkey_vk_codes> 或 WslPaste.exe clipboard
/// 输出: WSL 路径（带单引号）到 stdout，同时写入剪贴板
/// 退出码: 0=成功, 1=超时/取消, 2=无图片, 3=参数错误
/// </summary>
class WslPaste
{
    [DllImport("user32.dll")]
    static extern void keybd_event(byte bVk, byte bScan, int dwFlags, int dwExtraInfo);

    [DllImport("user32.dll")]
    static extern short GetAsyncKeyState(int vKey);

    const int KEYEVENTF_KEYUP = 2;
    const int VK_ESCAPE = 0x1B;

    [STAThread]
    static int Main(string[] args)
    {
        // 强制 UTF-8 输出，避免中文乱码
        Console.OutputEncoding = System.Text.Encoding.UTF8;

        if (args.Length == 0)
        {
            Console.Error.WriteLine("用法: WslPaste.exe <vk1 vk2 ...> 或 WslPaste.exe clipboard");
            return 3;
        }

        try
        {
            if (args[0].ToLower() == "clipboard")
            {
                // 直接读取剪贴板模式
                return ProcessClipboard();
            }
            else
            {
                // 截图模式：模拟快捷键 → 等待 → 处理
                return ScreenshotAndProcess(args);
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("错误: " + ex.Message);
            return 3;
        }
    }

    static int ScreenshotAndProcess(string[] vkArgs)
    {
        // 解析虚拟键码
        byte[] vks = new byte[vkArgs.Length];
        for (int i = 0; i < vkArgs.Length; i++)
        {
            vks[i] = byte.Parse(vkArgs[i]);
        }

        // 记录当前剪贴板图片指纹
        string oldFingerprint = GetClipboardFingerprint();

        // 模拟按键
        foreach (var vk in vks) keybd_event(vk, 0, 0, 0);
        Thread.Sleep(50);
        for (int i = vks.Length - 1; i >= 0; i--) keybd_event(vks[i], 0, KEYEVENTF_KEYUP, 0);

        // 等待剪贴板变化，同时监听 Esc
        int elapsed = 0;
        int timeout = 15000;
        while (elapsed < timeout)
        {
            Thread.Sleep(100);
            elapsed += 100;

            // 检测 Esc 取消
            if ((GetAsyncKeyState(VK_ESCAPE) & 0x8000) != 0)
            {
                Console.Error.WriteLine("已取消");
                return 1;
            }

            // 检测剪贴板变化
            string newFp = GetClipboardFingerprint();
            if (!string.IsNullOrEmpty(newFp) && newFp != oldFingerprint)
            {
                return ProcessClipboard();
            }
        }

        Console.Error.WriteLine("截图超时");
        return 1;
    }

    static string GetClipboardFingerprint()
    {
        for (int i = 0; i < 3; i++)
        {
            try
            {
                if (Clipboard.ContainsImage())
                {
                    var img = Clipboard.GetImage();
                    if (img != null)
                    {
                        string fp = img.Width + "x" + img.Height;
                        img.Dispose();
                        return fp;
                    }
                }
            }
            catch { Thread.Sleep(50); }
        }
        return "";
    }

    static int ProcessClipboard()
    {
        Image image = null;
        string existingFile = null;

        // 带重试的剪贴板读取
        for (int i = 0; i < 5; i++)
        {
            try
            {
                if (Clipboard.ContainsFileDropList())
                {
                    var files = Clipboard.GetFileDropList();
                    if (files.Count > 0)
                    {
                        existingFile = files[0];
                        break;
                    }
                }
                else if (Clipboard.ContainsImage())
                {
                    image = Clipboard.GetImage();
                    if (image != null) break;
                }
            }
            catch { Thread.Sleep(100); }
        }

        if (image == null && string.IsNullOrEmpty(existingFile))
        {
            Console.Error.WriteLine("剪贴板中没有图片");
            return 2;
        }

        // 获取文件路径
        string winPath = existingFile;
        if (image != null)
        {
            try
            {
                string dir = Path.Combine(Path.GetTempPath(), "wsl-paste-image");
                if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);

                string fileName = string.Format("wsl_shot_{0}.png", DateTime.Now.ToString("yyyyMMdd_HHmmss"));
                winPath = Path.Combine(dir, fileName);
                image.Save(winPath, ImageFormat.Png);
            }
            finally { image.Dispose(); }
        }

        if (string.IsNullOrEmpty(winPath)) return 2;

        // 转 WSL 路径
        string root = Path.GetPathRoot(winPath);
        string drive = root.Substring(0, 1).ToLower();
        string rel = winPath.Substring(root.Length).Replace("\\", "/");
        string wslPath = string.Format("'/mnt/{0}/{1}'", drive, rel);

        // 写入剪贴板
        for (int i = 0; i < 3; i++)
        {
            try { Clipboard.SetText(wslPath); break; }
            catch { Thread.Sleep(50); }
        }

        // 输出到 stdout
        Console.Write(wslPath);

        // 清理旧文件（超过1天）
        CleanOldFiles();

        return 0;
    }

    static void CleanOldFiles()
    {
        try
        {
            string dir = Path.Combine(Path.GetTempPath(), "wsl-paste-image");
            if (!Directory.Exists(dir)) return;
            var now = DateTime.Now;
            foreach (var f in Directory.GetFiles(dir, "wsl_shot_*.png"))
            {
                if ((now - File.GetLastWriteTime(f)).TotalDays > 1)
                    File.Delete(f);
            }
        }
        catch { }
    }
}
