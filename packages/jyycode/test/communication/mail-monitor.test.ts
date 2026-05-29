import { expect, test } from "bun:test"
import { isMailSessionTitle, ownerMailPrompt, parseMail } from "@/communication/mail-monitor"

test("parseMail extracts decoded text/plain body from multipart email", () => {
  const mail = parseMail(`Content-Type: multipart/alternative; boundary="b1"
From: User <user@example.com>
Subject: =?GB2312?B?0tHG9A==?=

--b1
Content-Type: text/plain; charset="gb2312"
Content-Transfer-Encoding: base64

xOO6ww0KDQpHZXQgT3V0bG9vayBmb3IgaU9TDQpfX19fX19fX19fX19fX19fX19fX18NCkZyb206IG9sZA==
--b1
Content-Type: text/html; charset="gb2312"
Content-Transfer-Encoding: quoted-printable

<html><body>=C4=E3=BA=C3</body></html>
--b1--`)

  expect(mail.subject).toBe("已启")
  expect(mail.body).toBe("你好")
})

test("parseMail falls back to decoded html text when plain text is absent", () => {
  const mail = parseMail(`Content-Type: multipart/alternative; boundary="b1"
From: User <user@example.com>
Subject: HTML

--b1
Content-Type: text/html; charset="gb2312"
Content-Transfer-Encoding: quoted-printable

<html><body><div>=C4=E3=BA=C3</div><div>=D3=CA=BC=FE</div></body></html>
--b1--`)

  expect(mail.body).toBe("你好\n邮件")
})

test("ownerMailPrompt only adds the email assistant instruction once and never includes subject", () => {
  const body = "帮我看一下当前状态"

  expect(ownerMailPrompt(false, body)).toBe(
    [
      "你是 JYYCode。下面这封邮件来自用户本人，请像持续对话中的助手一样自然回复。",
      "如果用户让你把本机文件“发过来”或“发给我”，默认使用 send_file 通过 email 发到 owner@example.com，除非用户明确指定其它收件人或渠道。",
      "",
      body,
    ].join("\n"),
  )
  expect(ownerMailPrompt(false, body)).not.toContain("主题")
  expect(ownerMailPrompt(false, body, "owner@example.com")).toContain("owner@example.com")
  expect(ownerMailPrompt(true, body)).toBe(body)
})

test("isMailSessionTitle matches only transient mail monitor sessions", () => {
  expect(isMailSessionTitle("Email: JYYCode startup")).toBe(true)
  expect(isMailSessionTitle("Reply email: Invoice")).toBe(true)
  expect(isMailSessionTitle("New session - Email draft")).toBe(false)
})
