export function displaySessionTitle(title: string) {
  if (title === "New session") return "\u65b0\u5efa\u4f1a\u8bdd"
  if (title === "Child session") return "\u5b50\u4f1a\u8bdd"
  if (title.startsWith("New session - ")) return `\u65b0\u5efa\u4f1a\u8bdd - ${title.slice("New session - ".length)}`
  if (title.startsWith("Child session - ")) return `\u5b50\u4f1a\u8bdd - ${title.slice("Child session - ".length)}`
  return title
}
