import type { ConversationMessage } from "./conversation-state"

export const COMPUTER_SCREENSHOT_LIMIT = 3
export const COMPUTER_SCREENSHOT_URL_BUDGET = 16 * 1024 * 1024

/** Bound desktop cache memory independently of server maintenance or missed SSE events. */
export function limitComputerScreenshots(messages: ConversationMessage[]): ConversationMessage[] {
  let count = 0
  let bytes = 0
  let result = messages
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m]!
    let parts = message.parts
    for (let p = parts.length - 1; p >= 0; p--) {
      const part = parts[p]!
      if (part.type !== "tool" || part.tool !== "computer" || part.state.status !== "completed") continue
      const attachments = part.state.attachments
      if (!attachments?.length) continue
      const keep = new Set<NonNullable<typeof attachments>[number]>()
      for (let a = attachments.length - 1; a >= 0; a--) {
        const attachment = attachments[a]!
        if (!attachment.mime.startsWith("image/")) {
          keep.add(attachment)
          continue
        }
        // Account for UTF-16 strings; blob references are small, inline legacy images are not.
        const size = attachment.url.length * 2
        if (count < COMPUTER_SCREENSHOT_LIMIT && bytes + size <= COMPUTER_SCREENSHOT_URL_BUDGET) {
          keep.add(attachment)
          bytes += size
        }
        count++
      }
      if (keep.size === attachments.length) continue
      if (parts === message.parts) parts = [...parts]
      const retained = attachments.filter((attachment) => keep.has(attachment))
      parts[p] = { ...part, state: { ...part.state, attachments: retained.length ? retained : undefined } }
    }
    if (parts === message.parts) continue
    if (result === messages) result = [...messages]
    result[m] = { ...message, parts }
  }
  return result
}
