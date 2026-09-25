param([switch]$Worker)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class JyyComputerNative {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint data; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit, Size=40)] public struct INPUT {
    [FieldOffset(0)] public uint type;
    [FieldOffset(8)] public KEYBDINPUT key;
    [FieldOffset(8)] public MOUSEINPUT mouse;
  }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", EntryPoint="SetProcessDpiAwarenessContext", SetLastError=true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT point, uint flags);
  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr monitor, int dpiType, out uint dpiX, out uint dpiY);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder title, int capacity);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  public static void SendKey(byte vk, bool up) {
    INPUT input = new INPUT(); input.type = 1; input.key.vk = vk; input.key.flags = up ? 2u : 0u;
    if (SendInput(1, new INPUT[] {input}, Marshal.SizeOf(typeof(INPUT))) != 1)
      throw new InvalidOperationException("SendInput could not press a key in the foreground application");
  }
  public static void SendMouse(uint flags, uint data) {
    INPUT input = new INPUT(); input.type = 0; input.mouse.flags = flags; input.mouse.data = data;
    if (SendInput(1, new INPUT[] {input}, Marshal.SizeOf(typeof(INPUT))) != 1)
      throw new InvalidOperationException("SendInput could not control the foreground application");
  }
  public static void MoveMouse(int x, int y) {
    int left = GetSystemMetrics(76), top = GetSystemMetrics(77);
    int width = GetSystemMetrics(78), height = GetSystemMetrics(79);
    if (width < 1 || height < 1 || x < left || x >= left + width || y < top || y >= top + height)
      throw new InvalidOperationException("Mouse coordinate is outside the virtual desktop");
    INPUT input = new INPUT(); input.type = 0;
    input.mouse.dx = (int)Math.Round((x - left) * 65535.0 / Math.Max(1, width - 1));
    input.mouse.dy = (int)Math.Round((y - top) * 65535.0 / Math.Max(1, height - 1));
    input.mouse.flags = 0xE001; // MOVE | MOVE_NOCOALESCE | VIRTUALDESK | ABSOLUTE
    if (SendInput(1, new INPUT[] {input}, Marshal.SizeOf(typeof(INPUT))) != 1)
      throw new InvalidOperationException("SendInput could not move the mouse cursor");
  }
  public static void TypeText(string text) {
    foreach (char ch in text) {
      INPUT down = new INPUT(); down.type = 1; down.key.scan = ch; down.key.flags = 4;
      INPUT up = new INPUT(); up.type = 1; up.key.scan = ch; up.key.flags = 6;
      if (SendInput(2, new INPUT[] {down, up}, Marshal.SizeOf(typeof(INPUT))) != 2)
        throw new InvalidOperationException("SendInput could not type into the foreground application");
    }
  }
  public static int GetEffectiveDpi(int x, int y) {
    try {
      POINT point = new POINT(); point.X = x; point.Y = y;
      IntPtr monitor = MonitorFromPoint(point, 2);
      uint dpiX, dpiY;
      return monitor != IntPtr.Zero && GetDpiForMonitor(monitor, 0, out dpiX, out dpiY) == 0 ? (int)dpiX : 96;
    } catch { return 96; }
  }
}
'@
try {
  if (-not [JyyComputerNative]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))) {
    [void][JyyComputerNative]::SetProcessDPIAware()
  }
} catch [System.EntryPointNotFoundException] {
  [void][JyyComputerNative]::SetProcessDPIAware()
}

function KeyCode([string]$name) {
  $keys = @{
    ctrl=0x11; control=0x11; shift=0x10; alt=0x12; win=0x5B; meta=0x5B; super=0x5B
    enter=0x0D; return=0x0D; tab=0x09; escape=0x1B; esc=0x1B; backspace=0x08; delete=0x2E
    space=0x20; up=0x26; down=0x28; left=0x25; right=0x27; home=0x24; end=0x23
    pageup=0x21; pagedown=0x22; insert=0x2D
  }
  $key = $name.ToLowerInvariant()
  if ($keys.ContainsKey($key)) { return [byte]$keys[$key] }
  if ($key -match '^f([1-9]|1[0-9]|2[0-4])$') { return [byte](0x6F + [int]$Matches[1]) }
  if ($key -match '^[a-z0-9]$') { return [byte][char]$key.ToUpperInvariant() }
  throw "Unsupported key: $name"
}

function PressKey([byte]$code, [bool]$up) {
  [JyyComputerNative]::SendKey($code, $up)
}

function MouseButton([string]$button, [bool]$up) {
  $flags = switch ($button) {
    left { if ($up) { 0x0004 } else { 0x0002 } }
    right { if ($up) { 0x0010 } else { 0x0008 } }
    middle { if ($up) { 0x0040 } else { 0x0020 } }
    default { throw "Unsupported mouse button: $button" }
  }
  [JyyComputerNative]::SendMouse([uint32]$flags, 0)
}

function MoveTo([int]$x, [int]$y) {
  [JyyComputerNative]::MoveMouse($x, $y)
}

function Assert-Window($step) {
  if (-not $step.expectWindow) { return }
  $current = [JyyComputerNative]::GetForegroundWindow().ToInt64().ToString()
  if ($current -ne [string]$step.expectWindow) {
    throw 'Foreground window changed since the last observation; observe and refocus the target before clicking or dragging'
  }
}

function Assert-Target($step) {
  if (-not $step.expectTarget) { return }
  $expected = $step.expectTarget
  if ($null -eq $step.x -or $null -eq $step.y) { throw 'Target guard requires a coordinate' }
  $point = [System.Windows.Point]::new([double]$step.x, [double]$step.y)
  try { $hit = [System.Windows.Automation.AutomationElement]::FromPoint($point) }
  catch { throw 'Target at coordinate could not be verified' }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  for ($depth = 0; $depth -lt 12 -and $null -ne $hit; $depth++) {
    try {
      $current = $hit.Current
      $rect = $current.BoundingRectangle
      $matchIdentity = if ($expected.automationId) {
        [string]$current.AutomationId -eq [string]$expected.automationId
      } elseif ($expected.name) {
        [string]$current.Name -eq [string]$expected.name
      } else {
        [string]$current.ControlType.ProgrammaticName -match [string]$expected.kind
      }
      $matchBox = [Math]::Abs($rect.Left - [double]$expected.x) -le 5 -and
        [Math]::Abs($rect.Top - [double]$expected.y) -le 5 -and
        [Math]::Abs($rect.Width - [double]$expected.width) -le 8 -and
        [Math]::Abs($rect.Height - [double]$expected.height) -le 8
      if ($matchIdentity -and $matchBox -and $current.IsEnabled -and -not $current.IsOffscreen) { return }
      $hit = $walker.GetParent($hit)
    } catch { break }
  }
  throw 'Target at coordinate changed or is covered; observe again'
}

function Perform-Action($step) {
switch ([string]$step.action) {
  observe { }
  move { MoveTo $step.x $step.y }
  click {
    Assert-Window $step
    Assert-Target $step
    if ($null -ne $step.x -and $null -ne $step.y) { MoveTo $step.x $step.y }
    $button = [string]$step.button
    if (-not $button) { $button = 'left' }
    $count = if ($step.double) { 2 } else { 1 }
    for ($i = 0; $i -lt $count; $i++) {
      MouseButton $button $false
      try { Start-Sleep -Milliseconds 35 }
      finally { MouseButton $button $true }
      if ($i -eq 0 -and $count -eq 2) { Start-Sleep -Milliseconds 75 }
    }
  }
  scroll {
    Assert-Window $step
    Assert-Target $step
    if ($null -ne $step.x -and $null -ne $step.y) { MoveTo $step.x $step.y }
    $amount = [int]$step.amount * 120
    $flag = if ($step.direction -eq 'left' -or $step.direction -eq 'right') { 0x1000 } else { 0x0800 }
    if ($step.direction -eq 'down' -or $step.direction -eq 'left') { $amount = -$amount }
    $wheelData = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$amount), 0)
    [JyyComputerNative]::SendMouse([uint32]$flag, $wheelData)
  }
  key {
    Assert-Window $step
    $parts = @(([string]$step.keys).Split('+') | ForEach-Object { $_.Trim() })
    $codes = @($parts | ForEach-Object { KeyCode $_ })
    $pressed = New-Object System.Collections.ArrayList
    try {
      foreach ($code in $codes) { PressKey $code $false; [void]$pressed.Add($code) }
    } finally {
      $pressed.Reverse()
      foreach ($code in $pressed) { PressKey $code $true }
    }
  }
  type {
    Assert-Window $step
    [JyyComputerNative]::TypeText([string]$step.text)
  }
  drag {
    Assert-Window $step
    Assert-Target $step
    if ($step.points) {
      $first = $step.points[0]
      MoveTo $first.x $first.y
      MouseButton 'left' $false
      try {
        for ($i = 1; $i -lt $step.points.Count; $i++) {
          Assert-Window $step
          MoveTo $step.points[$i].x $step.points[$i].y
          Start-Sleep -Milliseconds 8
        }
      } finally { MouseButton 'left' $true }
      break
    }
    MoveTo $step.x $step.y
    MouseButton 'left' $false
    try {
      for ($i = 1; $i -le 12; $i++) {
        Assert-Window $step
        $x = [int]($step.x + ($step.toX - $step.x) * $i / 12)
        $y = [int]($step.y + ($step.toY - $step.y) * $i / 12)
        MoveTo $x $y
        Start-Sleep -Milliseconds 15
      }
    } finally { MouseButton 'left' $true }
  }
  wait {
    if (-not $step.untilWindow) { Start-Sleep -Milliseconds ([int]$step.milliseconds); break }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $found = $false
    while ($watch.ElapsedMilliseconds -lt [int]$step.milliseconds) {
      $title = New-Object System.Text.StringBuilder 256
      [void][JyyComputerNative]::GetWindowText([JyyComputerNative]::GetForegroundWindow(), $title, $title.Capacity)
      if ($title.ToString().IndexOf([string]$step.untilWindow, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        $found = $true
        break
      }
      Start-Sleep -Milliseconds 50
    }
    if (-not $found) { throw "Timed out waiting for foreground window containing: $($step.untilWindow)" }
  }
  default { throw "Unsupported computer action: $($step.action)" }
}
}

function Run-Request($inputData, [string]$imagePath) {
if ($inputData.action -eq 'batch') {
  for ($i = 0; $i -lt $inputData.steps.Count; $i++) {
    $step = $inputData.steps[$i]
    Perform-Action $step
    if ($i + 1 -lt $inputData.steps.Count -and $inputData.steps[$i + 1].action -ne 'wait' -and
        ($step.action -eq 'click' -or $step.action -eq 'key')) { Start-Sleep -Milliseconds 50 }
  }
} else { Perform-Action $inputData }
if ($inputData.action -ne 'observe' -and $inputData.action -ne 'wait') { Start-Sleep -Milliseconds 100 }

$screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
$width = [int]$screen.Width
$height = [int]$screen.Height
if ($width -le 0 -or $height -le 0) { throw 'No active desktop screen' }
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try { $graphics.CopyFromScreen($screen.Left, $screen.Top, 0, 0, $bitmap.Size) }
finally { $graphics.Dispose() }
if ($inputData.rawImagePath) { $bitmap.Save([string]$inputData.rawImagePath, [System.Drawing.Imaging.ImageFormat]::Png) }

$elements = New-Object System.Collections.ArrayList
$handle = [JyyComputerNative]::GetForegroundWindow()
$title = New-Object System.Text.StringBuilder 256
[void][JyyComputerNative]::GetWindowText($handle, $title, $title.Capacity)
$windowName = $title.ToString()
if ($inputData.includeElements) {
  try {
  $cache = New-Object System.Windows.Automation.CacheRequest
  $cache.TreeScope = [System.Windows.Automation.TreeScope]::Element
  $cache.Add([System.Windows.Automation.AutomationElement]::NameProperty)
  $cache.Add([System.Windows.Automation.AutomationElement]::ControlTypeProperty)
  $cache.Add([System.Windows.Automation.AutomationElement]::AutomationIdProperty)
  $cache.Add([System.Windows.Automation.AutomationElement]::BoundingRectangleProperty)
  $cache.Add([System.Windows.Automation.AutomationElement]::IsOffscreenProperty)
  $cache.Add([System.Windows.Automation.AutomationElement]::IsEnabledProperty)
  $cache.Add([System.Windows.Automation.AutomationElement]::HasKeyboardFocusProperty)
  $activation = $cache.Activate()
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    try { $windowName = [string]$root.Cached.Name }
    catch { $windowName = [string]$root.Current.Name }
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue(@($root, 0))
    $visited = 0
    while ($queue.Count -gt 0 -and $elements.Count -lt 160 -and $visited -lt 800) {
    $entry = $queue.Dequeue()
    $element = $entry[0]
    $depth = [int]$entry[1]
    $visited++
    try {
      try { $current = $element.GetUpdatedCache($cache).Cached }
      catch { $current = $element.Current }
      $rect = $current.BoundingRectangle
      if (-not $current.IsOffscreen -and $rect.Width -gt 2 -and $rect.Height -gt 2 -and
          $rect.Right -gt $screen.Left -and $rect.Bottom -gt $screen.Top -and
          $rect.Left -lt $screen.Right -and $rect.Top -lt $screen.Bottom) {
        $name = [string]$current.Name
        $role = [string]$current.ControlType.ProgrammaticName
        $id = [string]$current.AutomationId
        if ($name.Length -gt 140) { $name = $name.Substring(0, 140) }
        if ($name -or $id -or $role -match 'Button|Edit|MenuItem|TabItem|ListItem|CheckBox|RadioButton|ComboBox') {
          [void]$elements.Add(@{
            index = $elements.Count + 1; name = $name; role = $role.Replace('ControlType.', ''); automationId = $id
            x = [int][Math]::Round($rect.Left); y = [int][Math]::Round($rect.Top)
            width = [int][Math]::Round($rect.Width); height = [int][Math]::Round($rect.Height)
            enabled = [bool]$current.IsEnabled; focused = [bool]$current.HasKeyboardFocus; depth = $depth
          })
        }
      }
      if ($depth -lt 24) {
        $child = $walker.GetFirstChild($element)
        $siblings = 0
        while ($null -ne $child -and $siblings -lt 100) {
          $queue.Enqueue(@($child, ($depth + 1)))
          $child = $walker.GetNextSibling($child)
          $siblings++
        }
      }
    } catch { continue }
    }
  } finally { $activation.Dispose() }
  } catch { }
}

$maxWidth = if ($inputData.resolution -eq 'high') { 2000.0 } else { 1280.0 }
$maxHeight = if ($inputData.resolution -eq 'high') { 1400.0 } else { 800.0 }
$scale = [Math]::Min(1.0, [Math]::Min($maxWidth / $width, $maxHeight / $height))
$imageWidth = [int][Math]::Max(1, [Math]::Round($width * $scale))
$imageHeight = [int][Math]::Max(1, [Math]::Round($height * $scale))
$output = New-Object System.Drawing.Bitmap($imageWidth, $imageHeight)
$draw = [System.Drawing.Graphics]::FromImage($output)
$draw.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$draw.DrawImage($bitmap, 0, 0, $imageWidth, $imageHeight)
try {
  if ($inputData.annotate) {
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(210, 255, 82, 49), 2)
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(230, 255, 82, 49))
    $font = New-Object System.Drawing.Font('Arial', 9, [System.Drawing.FontStyle]::Bold)
    try {
      foreach ($element in $elements) {
        if ($element.index -gt 80) { break }
        if ($element.role -notmatch 'Button|Edit|MenuItem|TabItem|ListItem|CheckBox|RadioButton|ComboBox|Hyperlink|ScrollBar|Slider') { continue }
        $x = [int][Math]::Round(($element.x - $screen.Left) * $scale)
        $y = [int][Math]::Round(($element.y - $screen.Top) * $scale)
        $w = [int][Math]::Max(1, [Math]::Round($element.width * $scale))
        $h = [int][Math]::Max(1, [Math]::Round($element.height * $scale))
        if ($w -lt 8 -or $h -lt 8) { continue }
        $draw.DrawRectangle($pen, $x, $y, $w, $h)
        $label = [string]$element.index
        $size = $draw.MeasureString($label, $font)
        $draw.FillRectangle($brush, $x, $y, [int]$size.Width + 4, [int]$size.Height)
        $draw.DrawString($label, $font, [System.Drawing.Brushes]::White, $x + 2, $y)
      }
    } finally { $pen.Dispose(); $brush.Dispose(); $font.Dispose() }
  }
  $output.Save($imagePath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $draw.Dispose(); $output.Dispose(); $bitmap.Dispose()
}
$point = New-Object JyyComputerNative+POINT
[void][JyyComputerNative]::GetCursorPos([ref]$point)
$monitors = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  $bounds = $_.Bounds
  $dpi = [JyyComputerNative]::GetEffectiveDpi([int]($bounds.Left + $bounds.Width / 2), [int]($bounds.Top + $bounds.Height / 2))
  @{ id = $_.DeviceName; bounds = @{ x = $bounds.Left; y = $bounds.Top; width = $bounds.Width; height = $bounds.Height }; dpiX = $dpi; dpiY = $dpi }
})
@{
  screen = @{ x = $screen.Left; y = $screen.Top; width = $width; height = $height }
  image = @{ width = $imageWidth; height = $imageHeight }
  rawImage = @{ width = $width; height = $height }
  monitors = $monitors
  cursor = @{ x = $point.X; y = $point.Y }
  window = $windowName
  windowID = $handle.ToInt64().ToString()
  elements = @($elements.ToArray())
} | ConvertTo-Json -Depth 6 -Compress
}

if ($Worker) {
  [Console]::Out.WriteLine('{"ready":true}')
  while ($null -ne ($line = [Console]::In.ReadLine())) {
    try {
      $request = $line | ConvertFrom-Json
      $result = Run-Request $request.input ([string]$request.image)
      [Console]::Out.WriteLine($result)
    } catch {
      [Console]::Out.WriteLine((@{ error = $_.Exception.Message } | ConvertTo-Json -Compress))
    }
  }
} else {
  $inputData = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:JYYCODE_COMPUTER_INPUT)) | ConvertFrom-Json
  Run-Request $inputData $env:JYYCODE_COMPUTER_IMAGE
}
