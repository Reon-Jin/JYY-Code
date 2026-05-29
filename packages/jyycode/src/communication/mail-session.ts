export function isMailSessionTitle(title: string) {
  return title.startsWith("Email: ") || title.startsWith("Reply email: ")
}

export * as MailSession from "./mail-session"
