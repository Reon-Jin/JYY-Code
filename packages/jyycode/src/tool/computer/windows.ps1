param([switch]$Worker)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
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
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
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
  public static void TypeText(string text) {
    foreach (char ch in text) {
      INPUT down = new INPUT(); down.type = 1; down.key.scan = ch; down.key.flags = 4;
      INPUT up = new INPUT(); up.type = 1; up.key.scan = ch; up.key.flags = 6;
      if (SendInput(2, new INPUT[] {down, up}, Marshal.SizeOf(typeof(INPUT))) != 2)
        throw new InvalidOperationException("SendInput could not type into the foreground application");
    }
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
  if (-not [JyyComputerNative]::SetCursorPos($x, $y)) { throw 'Could not move mouse cursor' }
}

function Perform-Action($step) {
switch ([string]$step.action) {
  observe { }
  move { MoveTo $step.x $step.y }
  click {
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
    if ($null -ne $step.x -and $null -ne $step.y) { MoveTo $step.x $step.y }
    $amount = [int]$step.amount * 120
    $flag = if ($step.direction -eq 'left' -or $step.direction -eq 'right') { 0x1000 } else { 0x0800 }
    if ($step.direction -eq 'down' -or $step.direction -eq 'left') { $amount = -$amount }
    $wheelData = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$amount), 0)
    [JyyComputerNative]::SendMouse([uint32]$flag, $wheelData)
  }
  key {
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
  type { [JyyComputerNative]::TypeText([string]$step.text) }
  drag {
    MoveTo $step.x $step.y
    MouseButton 'left' $false
    try {
      for ($i = 1; $i -le 12; $i++) {
        $x = [int]($step.x + ($step.toX - $step.x) * $i / 12)
        $y = [int]($step.y + ($step.toY - $step.y) * $i / 12)
        MoveTo $x $y
        Start-Sleep -Milliseconds 15
      }
    } finally { MouseButton 'left' $true }
  }
  wait { Start-Sleep -Milliseconds ([int]$step.milliseconds) }
  default { throw "Unsupported computer action: $($step.action)" }
}
}

function Run-Request($inputData, [string]$imagePath) {
if ($inputData.action -eq 'batch') {
  foreach ($step in $inputData.steps) { Perform-Action $step }
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

$elements = New-Object System.Collections.ArrayList
$windowName = ''
try {
  $handle = [JyyComputerNative]::GetForegroundWindow()
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
} catch { $windowName = '' }

$scale = [Math]::Min(1.0, [Math]::Min(2000.0 / $width, 1400.0 / $height))
$imageWidth = [int][Math]::Max(1, [Math]::Round($width * $scale))
$imageHeight = [int][Math]::Max(1, [Math]::Round($height * $scale))
$output = New-Object System.Drawing.Bitmap($imageWidth, $imageHeight)
$draw = [System.Drawing.Graphics]::FromImage($output)
$draw.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$draw.DrawImage($bitmap, 0, 0, $imageWidth, $imageHeight)
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
  $output.Save($imagePath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $draw.Dispose(); $output.Dispose(); $bitmap.Dispose(); $pen.Dispose(); $brush.Dispose(); $font.Dispose()
}
$point = New-Object JyyComputerNative+POINT
[void][JyyComputerNative]::GetCursorPos([ref]$point)
@{
  screen = @{ x = $screen.Left; y = $screen.Top; width = $width; height = $height }
  image = @{ width = $imageWidth; height = $imageHeight }
  cursor = @{ x = $point.X; y = $point.Y }
  window = $windowName
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
