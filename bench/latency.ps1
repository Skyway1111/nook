# Keystroke-to-screen latency: press a key, poll the screen until the typed cell changes, then erase it.
# Usage: latency.ps1 -X <px> -Y <px> [-W 160] [-H 40] [-Trials 40] [-Title nook]
#   Title: substring of the target window's title. Stops if that window loses focus, so keys never go elsewhere.
#   X/Y: window-relative physical pixels of the empty prompt, just right of the "> " marker.
param([int]$X, [int]$Y, [int]$W = 160, [int]$H = 40, [int]$Trials = 40, [string]$Title = 'nook')
Add-Type -ReferencedAssemblies System.Drawing @"
using System; using System.Diagnostics; using System.Drawing; using System.Drawing.Imaging;
using System.Runtime.InteropServices; using System.Threading;
public static class Lat {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr p);
  public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => { var sb = new System.Text.StringBuilder(512); GetWindowText(h, sb, 512);
      if (IsWindowVisible(h) && sb.ToString().Contains(title)) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  struct RECT { public int L, T, R, B; }
  static byte[] Grab(Rectangle r) {
    using (var bmp = new Bitmap(r.Width, r.Height, PixelFormat.Format32bppArgb)) {
      using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(r.Location, Point.Empty, r.Size);
      var d = bmp.LockBits(new Rectangle(Point.Empty, r.Size), ImageLockMode.ReadOnly, bmp.PixelFormat);
      var buf = new byte[d.Stride * r.Height]; Marshal.Copy(d.Scan0, buf, 0, buf.Length); bmp.UnlockBits(d);
      return buf;
    }
  }
  static bool Same(byte[] a, byte[] b) { for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false; return true; }
  static void Key(byte vk) { keybd_event(vk, 0, 0, IntPtr.Zero); keybd_event(vk, 0, 2, IntPtr.Zero); }
  // Waits until the region differs from (changed=true) or equals (changed=false) the reference.
  static double Wait(Rectangle r, byte[] reference, bool changed, int timeoutMs) {
    var sw = Stopwatch.StartNew();
    while (sw.ElapsedMilliseconds < timeoutMs) { if (Same(Grab(r), reference) != changed) return sw.Elapsed.TotalMilliseconds; }
    return -1;
  }
  public static double[] Run(IntPtr hwnd, int x, int y, int w, int h, int trials) {
    SetProcessDPIAware(); SetForegroundWindow(hwnd); Thread.Sleep(400);
    RECT wr; GetWindowRect(hwnd, out wr);
    var r = new Rectangle(wr.L + x, wr.T + y, w, h);
    var results = new double[trials];
    for (int i = 0; i < trials; i++) {
      if (GetForegroundWindow() != hwnd) throw new Exception("target window lost focus; stopped");
      var before = Grab(r);
      var sw = Stopwatch.StartNew(); Key(0x58); // 'x'
      double t = Wait(r, before, true, 3000);
      results[i] = t < 0 ? -1 : sw.Elapsed.TotalMilliseconds;
      Key(0x08); // backspace
      Wait(r, before, false, 3000);
      Thread.Sleep(60 + (i * 37) % 90); // de-sync from the display's refresh cadence
    }
    return results;
  }
}
"@
$hwnd = [Lat]::Find($Title)
if ($hwnd -eq [IntPtr]::Zero) { throw "no visible window titled *$Title*" }
$ms = [Lat]::Run($hwnd, $X, $Y, $W, $H, $Trials) | Where-Object { $_ -ge 0 } | Sort-Object
$pick = { param($q) $ms[[Math]::Min($ms.Count - 1, [int][Math]::Floor($q * $ms.Count))] }
'{0}: n={1} median={2:N1}ms p90={3:N1}ms max={4:N1}ms' -f $Title, $ms.Count, (& $pick 0.5), (& $pick 0.9), $ms[-1]
