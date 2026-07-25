import type { Adapter, AdapterConfig, SendResult } from "./schema"
import { spawn } from "node:child_process"

function powershell(script: string, timeoutMs = 15000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, "utf-16le").toString("base64")
    const child = spawn(
      "powershell",
      ["-STA", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { timeout: timeoutMs, windowsHide: true },
    )
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()))
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()))
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(stderr || stdout || `PowerShell exited with code ${code}`))
    })
    child.on("error", reject)
  })
}

async function sendViaWeChat(input: { to: string; body: string; filePath?: string }): Promise<SendResult> {
  const escapedBody = input.body.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "`n").replace(/\r/g, "")
  const escapedFile = input.filePath?.replace(/\\/g, "\\\\").replace(/"/g, '\\"') || ""
  const escapedTo = input.to.replace(/\\/g, "\\\\").replace(/"/g, '\\"')

  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Check for WeChat process - try multiple possible process names
$wechatProcessNames = @("weixin", "wechat", "WeChat", "WeChatAppEx")
$found = $false
foreach ($pname in $wechatProcessNames) {
    try {
        $result = (Get-Process -Name $pname -ErrorAction SilentlyContinue)
        if ($result) { $found = $true; break }
    } catch {}
}
if (-not $found) {
    Write-Output "ERROR:WeChat is not running. Please start WeChat and log in first."
    exit 1
}

# Try to activate WeChat window with multiple title attempts
$wechatTitles = @("微信", "WeChat", "Weixin")
$activated = $false
for ($i = 0; $i -lt 20; $i++) {
    foreach ($wtitle in $wechatTitles) {
        try {
            $wshell = New-Object -ComObject WScript.Shell
            $result = $wshell.AppActivate($wtitle)
            if ($result) {
                $activated = $true
                break
            }
        } catch {}
    }
    if ($activated) { break }
    Start-Sleep -Milliseconds 250
}
if (-not $activated) {
    Write-Output "ERROR:Could not activate WeChat window. Make sure the main WeChat window is open and not minimized to tray."
    exit 1
}

Start-Sleep -Milliseconds 300

# Use Ctrl+F to open search
[System.Windows.Forms.SendKeys]::SendWait("^f")
Start-Sleep -Milliseconds 400

# Clear and type contact name via clipboard
[System.Windows.Forms.SendKeys]::SendWait("^a")
Start-Sleep -Milliseconds 100
[System.Windows.Forms.SendKeys]::SendWait("{BACKSPACE}")
Start-Sleep -Milliseconds 100

[System.Windows.Forms.Clipboard]::SetText("${escapedTo}")
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds 600
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Start-Sleep -Milliseconds 500

# Paste and send the message
[System.Windows.Forms.Clipboard]::SetText("${escapedBody}")
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds 300

${
  input.filePath
    ? `
# For file attachment
[System.Windows.Forms.Clipboard]::SetText("${escapedFile}")
[System.Windows.Forms.SendKeys]::SendWait("^v")
Start-Sleep -Milliseconds 500
`
    : ""
}

[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Start-Sleep -Milliseconds 200

Write-Output "OK:Message sent to ${escapedTo} via WeChat"
`

  try {
    const result = await powershell(script)
    if (result.stdout.includes("ERROR:")) {
      const msg = result.stdout.split("ERROR:")[1]?.trim() || "Unknown error"
      return { success: false, channel: "wechat", message: msg }
    }
    return { success: true, channel: "wechat", message: `Message sent to ${input.to} via WeChat` }
  } catch (error: any) {
    return {
      success: false,
      channel: "wechat",
      message: `WeChat automation failed: ${error.message}. Make sure WeChat is running and logged in.`,
    }
  }
}

export const WeChatAdapter: Adapter = {
  channel: "wechat" as const,

  async send(_config: AdapterConfig, input: { to: string; body: string; subject?: string }): Promise<SendResult> {
    return sendViaWeChat(input)
  },

  async sendFile(_config: AdapterConfig, input: { to: string; filePath: string; body?: string }): Promise<SendResult> {
    const msg = input.body || `[File] ${input.filePath.split(/[/\\]/).pop()}`
    return sendViaWeChat({ to: input.to, body: msg, filePath: input.filePath })
  },
}
