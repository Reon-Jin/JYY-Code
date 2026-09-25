import { MessageV2 } from "@/session/message-v2"
import type { SessionID } from "@/session/schema"

const quoted = /“[^”]*”|‘[^’]*’|「[^」]*」|"[^"]*"|'[^']*'/g
const fenced = /```[\s\S]*?```/g
const chineseCapability = "(?:电脑控制|电脑操控|桌面控制)(?:能力|功能)?"
const chineseRequest = new RegExp(
  "^" +
    "(?:(?:我(?:想|希望|需要)(?:让|请)?你|请继续|继续|请|麻烦|帮我|替我|为我)\\s*)?" +
    "(?:请|帮我|替我|为我)?\\s*(?:用|使用|通过|调用|启用|开启)\\s*" +
    "(?:你(?:的)?|JYYCode(?:的)?)?\\s*" + chineseCapability,
  "i",
)
const chineseDirect = new RegExp(
  "^(?:请|麻烦|帮我)?\\s*(?:操控|控制|操作)\\s*(?:我的|这台)?\\s*(?:电脑|桌面|屏幕)",
)
const chineseScreenAction = new RegExp(
  "^(?:请|麻烦|帮我)?\\s*(?:在(?:我的|这台)?(?:电脑|桌面|屏幕)上\\s*(?:帮我)?\\s*(?:点击|双击|拖动|滚动|按下|输入)|(?:点击|双击|拖动|滚动|按下)\\s*(?:我的|这台)?(?:电脑|桌面|屏幕))",
)
const englishRequest = /^(?:(?:i (?:want|need) you to|please|jyycode[, ]*)\s*)?(?:continue (?:to use|using)|use|enable|start)\s+(?:your\s+)?(?:computer control|computer use|desktop control)/i
const englishDirect = /^(?:please\s+)?(?:control|operate)\s+(?:my|the|this)\s+(?:computer|desktop)/i
const englishScreenAction = /^(?:please\s+)?(?:click|drag|scroll|type)\s+on\s+(?:my|the)\s+(?:screen|desktop)/i
const negated = /(?:不要|别|禁止|禁用|请勿|无需|不用|不需要|不允许|不得|不可|do not|don't|never|without)\s*.{0,18}(?:电脑控制|电脑操控|桌面控制|(?:操控|控制|操作).{0,4}(?:电脑|桌面|屏幕)|computer control|computer use|desktop control|control.{0,8}(?:computer|desktop))/i
const excluded = /(?:电脑控制|电脑操控|桌面控制)(?:能力|功能)?(?:以外|之外|除外)|(?:computer control|computer use|desktop control)\s+(?:except|other than)/i

export function explicitComputerControlRequest(text: string) {
  if (/^(?:[>"'“‘「]|```)/.test(text.trimStart())) return false
  const visible = text
    .replace(fenced, "")
    .replace(/^\s*>.*$/gm, "")
    .replace(quoted, (match) => {
      const label = match.slice(1, -1)
      return /^(?:电脑控制|电脑操控|桌面控制|computer control|computer use|desktop control)$/i.test(label) ? label : ""
    })
    .trim()
  if (!visible || negated.test(visible) || excluded.test(visible)) return false
  return chineseRequest.test(visible) || chineseDirect.test(visible) || chineseScreenAction.test(visible) ||
    englishRequest.test(visible) || englishDirect.test(visible) || englishScreenAction.test(visible) ||
    /^(?:电脑控制|电脑操控|桌面控制)[：:,，]\s*\S+/.test(visible)
}

function internalUserMessage(message: MessageV2.WithParts) {
  return message.parts.length > 0 && message.parts.every((part) =>
    (part.type === "text" && part.synthetic === true) || part.type === "compaction" || part.type === "subtask")
}

function userText(message: MessageV2.WithParts) {
  return message.parts
    .filter((part): part is MessageV2.TextPart => part.type === "text" && !part.synthetic && !part.ignored)
    .map((part) => part.text)
    .join("\n")
}

/** Only the latest real user request can authorize computer control. */
export function computerControlRequestedNewest(messages: Iterable<MessageV2.WithParts>) {
  for (const message of messages) {
    if (message.info.role !== "user" || internalUserMessage(message)) continue
    return explicitComputerControlRequest(userText(message))
  }
  return false
}

/** Authorization belongs to the current real user request, never to model text or attached files. */
export function computerControlRequested(messages: readonly MessageV2.WithParts[]) {
  const users = messages
    .filter((message) => message.info.role === "user" && !internalUserMessage(message))
    .sort((a, b) => MessageV2.compareChronological(b.info, a.info))
  return computerControlRequestedNewest(users)
}

/** Compaction can drop the original request from model context; use the persisted user history then. */
export function computerControlRequestedInSession(messages: readonly MessageV2.WithParts[], sessionID: SessionID) {
  if (computerControlRequested(messages)) return true
  if (!messages.some((message) => message.parts.some((part) => part.type === "compaction"))) return false
  if (messages.some((message) => message.info.role === "user" && !internalUserMessage(message))) return false
  return computerControlRequestedNewest(MessageV2.stream(sessionID))
}

export function assertComputerControlRequested(messages: readonly MessageV2.WithParts[], sessionID: SessionID) {
  if (!computerControlRequestedInSession(messages, sessionID)) {
    throw new Error("Computer control requires an explicit request from the user in the current task")
  }
}

export function assertComputerControlRequestedLive(sessionID: SessionID) {
  if (!computerControlRequestedNewest(MessageV2.stream(sessionID))) {
    throw new Error("Computer control requires an explicit request from the user in the current task")
  }
}
