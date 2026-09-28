param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$Combination
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class NativeKeys {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
    [DllImport("user32.dll")] public static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    public static IntPtr FindBestWindow(uint targetPid) {
        IntPtr best = IntPtr.Zero;
        long bestScore = long.MinValue;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            if (pid != targetPid || !IsWindowVisible(hWnd)) return true;

            RECT rect;
            GetWindowRect(hWnd, out rect);
            long area = (long)(rect.Right - rect.Left) * (rect.Bottom - rect.Top);

            int len = GetWindowTextLength(hWnd);
            string title = "";
            if (len > 0) {
                StringBuilder buffer = new StringBuilder(len + 1);
                GetWindowText(hWnd, buffer, buffer.Capacity);
                title = buffer.ToString();
            }
            bool isChrome = title.IndexOf("Chrome", StringComparison.OrdinalIgnoreCase) >= 0;
            long score = area + (isChrome ? 1000000000L : 0);
            if (score > bestScore) { bestScore = score; best = hWnd; }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    public static void PressKey(byte virtualKey) {
        keybd_event(virtualKey, 0, 0, UIntPtr.Zero);
        keybd_event(virtualKey, 0, 2, UIntPtr.Zero);
    }

    public static bool ForceForeground(IntPtr hWnd) {
        PressKey(0x12);
        ShowWindow(hWnd, 9);
        SwitchToThisWindow(hWnd, true);
        SetForegroundWindow(hWnd);
        System.Threading.Thread.Sleep(200);
        if (GetForegroundWindow() == hWnd) return true;

        IntPtr foreground = GetForegroundWindow();
        uint foregroundThread = GetWindowThreadProcessId(foreground, IntPtr.Zero);
        uint currentThread = GetCurrentThreadId();
        bool attached = false;
        if (foregroundThread != 0 && foregroundThread != currentThread) {
            attached = AttachThreadInput(currentThread, foregroundThread, true);
        }
        try {
            PressKey(0x12);
            ShowWindow(hWnd, 9);
            SetActiveWindow(hWnd);
            SwitchToThisWindow(hWnd, true);
            SetForegroundWindow(hWnd);
            System.Threading.Thread.Sleep(200);
        }
        finally {
            if (attached) AttachThreadInput(currentThread, foregroundThread, false);
        }
        return GetForegroundWindow() == hWnd;
    }
}
'@

$hwnd = [NativeKeys]::FindBestWindow([uint32]$ProcessId)
if ($hwnd -eq [IntPtr]::Zero) {
    Write-Output "ERROR: no visible window for pid $ProcessId"
    exit 2
}

$focused = $false
for ($attempt = 1; $attempt -le 3 -and -not $focused; $attempt++) {
    $focused = [NativeKeys]::ForceForeground($hwnd)
    if (-not $focused) { Start-Sleep -Milliseconds 300 }
}
if (-not $focused) {
    Write-Output "ERROR: could not focus window $hwnd (foreground=$([NativeKeys]::GetForegroundWindow()))"
    exit 3
}

Start-Sleep -Milliseconds 250

$modifierMap = @{
    "alt"     = 0x12
    "ctrl"    = 0x11
    "control" = 0x11
    "shift"   = 0x10
}

$parts = $Combination.ToLower().Split("+") | ForEach-Object { $_.Trim() }
$keyPart = $parts[-1]
$modifiers = @()
for ($i = 0; $i -lt $parts.Length - 1; $i++) {
    if ($modifierMap.ContainsKey($parts[$i])) {
        $modifiers += [byte]$modifierMap[$parts[$i]]
    }
    else {
        Write-Output "ERROR: unknown modifier '$($parts[$i])'"
        exit 4
    }
}

if ($keyPart.Length -eq 1) {
    $char = $keyPart.ToUpper()[0]
    if ([char]::IsLetter($char) -or [char]::IsDigit($char)) {
        $virtualKey = [byte][char]$char
    }
    else {
        Write-Output "ERROR: unsupported key '$keyPart'"
        exit 5
    }
}
else {
    Write-Output "ERROR: unsupported key '$keyPart'"
    exit 5
}

foreach ($modifier in $modifiers) {
    [NativeKeys]::keybd_event($modifier, 0, 0, [UIntPtr]::Zero)
}
Start-Sleep -Milliseconds 50
[NativeKeys]::PressKey($virtualKey)
Start-Sleep -Milliseconds 50
for ($i = $modifiers.Length - 1; $i -ge 0; $i--) {
    [NativeKeys]::keybd_event($modifiers[$i], 0, 2, [UIntPtr]::Zero)
}

Write-Output "ok target=$hwnd focused=true"
exit 0
