import type { Socket } from "node:net"
import type { Adapter, AdapterConfig, EmailHeaders, SendResult } from "./schema"
import { EOL } from "os"

export const EmailAdapter: Adapter = {
  channel: "email" as const,

  async send(
    config: AdapterConfig,
    input: { to: string; body: string; subject?: string; cc?: string; headers?: EmailHeaders },
  ): Promise<SendResult> {
    if (!config.email) {
      return { success: false, channel: "email", message: "Email not configured. Set email config in jyycode.jsonc" }
    }

    const { smtpHost, smtpPort, username, password, from, authMethod } = config.email
    const port = smtpPort ?? 587
    const useOAuth2 = authMethod === "oauth2"
    const subject = input.subject || "Message from JYYCode"

    const headers = [
      `From: ${from}`,
      `To: ${input.to}`,
      `Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "Content-Transfer-Encoding: base64",
      ...(input.cc ? [`Cc: ${input.cc}`] : []),
      ...emailThreadHeaders(input.headers),
    ]

    const body = base64(input.body)
    const message = [...headers, "", body].join("\r\n")

    try {
      let { conn, tls } = await connect(smtpHost, port)

      await smtpCommand(conn, undefined)
      await smtpCommand(conn, `EHLO jyycode`)

      if (!tls && port === 587) {
        await smtpCommand(conn, `STARTTLS`)
        conn = await upgradeToTLS(conn, smtpHost)
        tls = true
        await smtpCommand(conn, `EHLO jyycode`)
      }

      if (useOAuth2) {
        const token = await getAccessToken(config.email!)
        await smtpCommand(conn, `AUTH XOAUTH2 ${xoauth2Token(username, token)}`)
      } else {
        await smtpCommand(conn, `AUTH LOGIN`)
        await smtpCommand(conn, btoa(username))
        await smtpCommand(conn, btoa(password))
      }

      await smtpCommand(conn, `MAIL FROM:<${from}>`)
      await smtpCommand(conn, `RCPT TO:<${input.to}>`)
      await smtpCommand(conn, `DATA`)
      await smtpCommand(conn, message + "\r\n.")
      await smtpCommand(conn, `QUIT`)
      conn.destroy()

      return { success: true, channel: "email", message: `Email sent to ${input.to}` }
    } catch (error: any) {
      return { success: false, channel: "email", message: `Failed to send email: ${error.message}` }
    }
  },

  async sendFile(
    config: AdapterConfig,
    input: { to: string; filePath: string; body?: string; subject?: string },
  ): Promise<SendResult> {
    if (!config.email) {
      return { success: false, channel: "email", message: "Email not configured. Set email config in jyycode.jsonc" }
    }

    const { smtpHost, smtpPort, username, password, from, authMethod } = config.email
    const port = smtpPort ?? 587
    const useOAuth2 = authMethod === "oauth2"
    const subject = input.subject || `File from JYYCode: ${input.filePath.split(/[/\\]/).pop()}`
    const fs = await import("node:fs/promises")
    const path = await import("node:path")

    try {
      const fileData = await fs.readFile(input.filePath)
      const fileName = path.basename(input.filePath)
      const boundary = `----JYYCodeBoundary${Date.now()}`
      const mimeType = getMimeType(fileName)

      const body = [
        `From: ${from}`,
        `To: ${input.to}`,
        `Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`,
        "MIME-Version: 1.0",
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        "",
        `--${boundary}`,
        'Content-Type: text/plain; charset="UTF-8"',
        "Content-Transfer-Encoding: base64",
        "",
        base64(input.body || `Sending file: ${fileName}`),
        "",
        `--${boundary}`,
        `Content-Type: ${mimeType}`,
        `Content-Disposition: attachment; filename="${fileName}"`,
        "Content-Transfer-Encoding: base64",
        "",
        wrapBase64(fileData.toString("base64")),
        "",
        `--${boundary}--`,
      ].join("\r\n")

      let { conn, tls } = await connect(smtpHost, port)

      await smtpCommand(conn, undefined)
      await smtpCommand(conn, `EHLO jyycode`)

      if (!tls && port === 587) {
        await smtpCommand(conn, `STARTTLS`)
        conn = await upgradeToTLS(conn, smtpHost)
        tls = true
        await smtpCommand(conn, `EHLO jyycode`)
      }

      if (useOAuth2) {
        const token = await getAccessToken(config.email!)
        await smtpCommand(conn, `AUTH XOAUTH2 ${xoauth2Token(username, token)}`)
      } else {
        await smtpCommand(conn, `AUTH LOGIN`)
        await smtpCommand(conn, btoa(username))
        await smtpCommand(conn, btoa(password))
      }

      await smtpCommand(conn, `MAIL FROM:<${from}>`)
      await smtpCommand(conn, `RCPT TO:<${input.to}>`)
      await smtpCommand(conn, `DATA`)
      await smtpCommand(conn, body + "\r\n.")
      await smtpCommand(conn, `QUIT`)
      conn.destroy()

      return { success: true, channel: "email", message: `File ${fileName} sent to ${input.to}` }
    } catch (error: any) {
      return { success: false, channel: "email", message: `Failed to send file: ${error.message}` }
    }
  },
}

function emailThreadHeaders(headers: EmailHeaders | undefined) {
  return [
    headers?.inReplyTo ? `In-Reply-To: ${safeHeaderValue(headers.inReplyTo)}` : undefined,
    headers?.references ? `References: ${safeHeaderValue(headers.references)}` : undefined,
  ].filter((item): item is string => item !== undefined)
}

function safeHeaderValue(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim()
}

function base64(value: string) {
  return wrapBase64(Buffer.from(value, "utf8").toString("base64"))
}

function wrapBase64(value: string) {
  return value.replace(/.{1,76}/g, "$&\r\n").trimEnd()
}

async function connect(host: string, port: number): Promise<{ conn: Socket; tls: boolean }> {
  if (port === 465) {
    const tls = await import("node:tls")
    const conn = tls.connect({ host, port, servername: host })
    return { conn, tls: true }
  }
  const net = await import("node:net")
  const conn = net.connect({ host, port })
  return { conn, tls: false }
}

async function upgradeToTLS(conn: Socket, host: string): Promise<Socket> {
  const tls = await import("node:tls")
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket: conn, servername: host }, () => {
      resolve(secure)
    })
    secure.on("error", reject)
  })
}

function xoauth2Token(username: string, accessToken: string): string {
  const raw = `user=${username}\x01auth=Bearer ${accessToken}\x01\x01`
  return btoa(raw)
}

async function getAccessToken(emailCfg: {
  username: string
  clientId?: string
  tenant?: string
  refreshToken?: string
}): Promise<string> {
  const clientId = emailCfg.clientId
  if (!clientId) {
    throw new Error(
      "OAuth2 clientId is required. Register an app at https://portal.azure.com and add clientId to email config.",
    )
  }

  const tenant = emailCfg.tenant || "consumers"

  if (emailCfg.refreshToken) {
    const response = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: emailCfg.refreshToken,
        scope: "https://outlook.office.com/SMTP.Send offline_access",
      }),
    })

    if (response.ok) {
      const data = (await response.json()) as Record<string, unknown>
      if (data.access_token) return data.access_token as string
    }

    throw new Error(
      "Refresh token expired. Run the device code flow again by removing refreshToken from config and re-running the send command.",
    )
  }

  const deviceResponse = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/devicecode`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      scope: "https://outlook.office.com/SMTP.Send offline_access",
    }),
  })

  if (!deviceResponse.ok) {
    const text = await deviceResponse.text()
    throw new Error(`Device code request failed: ${text}`)
  }

  const deviceData = (await deviceResponse.json()) as Record<string, unknown>

  process.stderr.write(EOL + "=== Outlook OAuth2 Device Login ===" + EOL)
  process.stderr.write(`Open: ${deviceData.verification_uri || "https://microsoft.com/devicelogin"}` + EOL)
  process.stderr.write(`Code:  ${deviceData.user_code}` + EOL)
  process.stderr.write("Waiting for authentication..." + EOL)

  const interval = (deviceData.interval as number) || 5
  const expiresIn = (deviceData.expires_in as number) || 900

  const startedAt = Date.now()
  while (Date.now() - startedAt < expiresIn * 1000) {
    await sleep(interval * 1000)

    const tokenResponse = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceData.device_code as string,
      }),
    })

    const tokenData = (await tokenResponse.json()) as Record<string, unknown>
    const error = tokenData.error as string

    if (error === "authorization_pending") continue
    if (error === "slow_down") {
      // Server wants us to slow down polling
      continue
    }

    if (tokenData.access_token) {
      const accessToken = tokenData.access_token as string
      const refreshToken = tokenData.refresh_token as string | undefined

      if (refreshToken) {
        process.stderr.write(EOL + "Add this refreshToken to jyycode.jsonc email config to skip login next time:" + EOL)
        process.stderr.write(`  "refreshToken": "${refreshToken}"` + EOL + EOL)
      } else {
        process.stderr.write(
          EOL + "Authentication successful (no refresh token returned; check client configuration)." + EOL + EOL,
        )
      }

      return accessToken
    }

    throw new Error(`Token request failed: ${JSON.stringify(tokenData)}`)
  }

  throw new Error("Device code authentication timed out. Please try again.")
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function getMimeType(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase()
  const types: Record<string, string> = {
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    zip: "application/zip",
    txt: "text/plain",
    json: "application/json",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
  }
  return types[ext || ""] || "application/octet-stream"
}

async function smtpCommand(
  conn: {
    write: (data: string) => void
    on: (event: string, cb: (data: Buffer) => void) => void
    off?: (event: string, cb: (data: Buffer) => void) => void
    destroy: () => void
    removeListener?: (event: string, cb: (data: Buffer) => void) => void
  },
  cmd: string | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let response = ""
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error("SMTP timeout"))
    }, 15000)
    const cleanup = () => {
      clearTimeout(timer)
      conn.off?.("data", onData)
      conn.removeListener?.("data", onData)
    }
    const onData = (data: Buffer) => {
      response += data.toString()
      if (!completeSmtpResponse(response)) return
      cleanup()
      if (/^[23]\d\d[ -]/.test(response)) {
        resolve(response)
        return
      }
      reject(new Error(`SMTP error: ${response.trim()}`))
    }
    conn.on("data", onData)
    if (cmd !== undefined) conn.write(cmd + "\r\n")
  })
}

function completeSmtpResponse(response: string) {
  const lines = response.split(/\r?\n/).filter(Boolean)
  const code = lines[0]?.match(/^(\d{3})[ -]/)?.[1]
  if (!code) return false
  return lines.some((line) => line.startsWith(`${code} `))
}
