# What bench/windows.mjs can't do from Node: find nook's window, focus and resize it, and read the CPU and memory
# of nook and its WebView2 processes.
#   windows.ps1 idle <pid> <ms>    focuses nook's window, waits ms, and prints {"cpu": % of one core, "memory": MB}
#   windows.ps1 resize <pid> <n>   resizes nook's window n times, 150 ms apart, smaller and back
param([string]$Verb, [int]$Id, [int]$N)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class NookWin {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr p);
  struct RECT { public int L, T, R, B; }
  // The largest visible top-level window of process `pid`.
  public static IntPtr Find(uint pid) {
    IntPtr found = IntPtr.Zero;
    int area = 0;
    EnumWindows((h, p) => {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      RECT r;
      if (owner == pid && IsWindowVisible(h) && GetWindowRect(h, out r) && (r.R - r.L) * (r.B - r.T) > area) {
        area = (r.R - r.L) * (r.B - r.T);
        found = h;
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  // n resizes, 150 ms apart: 180 by 120 pixels smaller, then back, ending at the size it started.
  public static void Resize(IntPtr h, int n) {
    RECT r;
    GetWindowRect(h, out r);
    for (int k = 0; k < n; k++) {
      int less = k % 2 == 0 ? 1 : 0;
      SetWindowPos(h, IntPtr.Zero, 0, 0, r.R - r.L - 180 * less, r.B - r.T - 120 * less, 0x16); // NOMOVE NOZORDER NOACTIVATE
      System.Threading.Thread.Sleep(150);
    }
  }
}
"@
[NookWin]::SetProcessDPIAware() | Out-Null

# nook and the WebView2 processes under it. The tab's shell and console host don't count.
function Ours([int]$root) {
  $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name)
  $in = @{ $root = $true }
  do {
    $grew = $false
    foreach ($p in $all) {
      if (-not $in.ContainsKey([int]$p.ProcessId) -and $in.ContainsKey([int]$p.ParentProcessId)) { $in[[int]$p.ProcessId] = $true; $grew = $true }
    }
  } while ($grew)
  $all | Where-Object { $in.ContainsKey([int]$_.ProcessId) -and ($_.ProcessId -eq $root -or $_.Name -eq 'msedgewebview2.exe') } | ForEach-Object { [int]$_.ProcessId }
}
function Processes($ids) { foreach ($i in $ids) { Get-Process -Id $i -ErrorAction SilentlyContinue } }

$window = [NookWin]::Find($Id)
if ($window -eq [IntPtr]::Zero) { throw "no window for process $Id" }
if ($Verb -eq 'idle') {
  [NookWin]::SetForegroundWindow($window) | Out-Null # the wallpaper moves only while nook has focus
  Start-Sleep -Milliseconds 300
  $ids = @(Ours $Id)
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $before = (Processes $ids | ForEach-Object { $_.TotalProcessorTime.TotalSeconds } | Measure-Object -Sum).Sum
  Start-Sleep -Milliseconds $N
  $after = (Processes $ids | ForEach-Object { $_.TotalProcessorTime.TotalSeconds } | Measure-Object -Sum).Sum
  $seconds = $clock.Elapsed.TotalSeconds
  $memory = (Processes $ids | Measure-Object -Property PrivateMemorySize64 -Sum).Sum / 1MB
  @{ cpu = 100 * ($after - $before) / $seconds; memory = $memory } | ConvertTo-Json -Compress
} elseif ($Verb -eq 'resize') {
  [NookWin]::Resize($window, $N)
} else {
  throw "unknown verb $Verb"
}
