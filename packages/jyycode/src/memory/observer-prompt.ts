import * as Log from "@jyycode-ai/core/util/log"

const log = Log.create({ service: "observer-prompt" })

const OBS_PROMPT_FIELD_MAX_CHARS = 16_000
const OBS_PROMPT_FIELD_HEAD_RATIO = 0.6
const OBS_PROMPT_FIELD_TAIL_RATIO = 0.3

export interface ParsedObservation {
  type: string
  title: string | null
  subtitle: string | null
  facts: string[]
  concepts: string[]
  narrative: string | null
  files_read: string[]
  files_modified: string[]
}

function truncateField(value: unknown, maxChars: number = OBS_PROMPT_FIELD_MAX_CHARS): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? ""
  if (raw.length <= maxChars) return raw
  const headChars = Math.max(0, Math.floor(maxChars * OBS_PROMPT_FIELD_HEAD_RATIO))
  const tailChars = Math.max(0, Math.floor(maxChars * OBS_PROMPT_FIELD_TAIL_RATIO))
  const head = raw.slice(0, headChars)
  const tail = tailChars > 0 ? raw.slice(-tailChars) : ""
  const elided = Math.max(0, raw.length - head.length - tail.length)
  return `${head}\n... <elided chars="${elided}" original_size_chars="${raw.length}" reason="oversize" /> ...\n${tail}`
}

export function buildObserverInitPrompt(project: string): string {
  return `You are a memory observer for JYYCode. Your role is to watch tool executions and extract durable knowledge.

You work in a background session. Your task: analyze the user's request and the assistant's response below. Extract structured observations about:
- **discovery**: new facts learned about the user, project, codebase, or domain
- **lesson**: things that went wrong and what was learned (bugs, errors, pitfalls)
- **convention**: engineering conventions, preferences, or coding patterns observed
- **preference**: user communication or workflow preferences explicitly stated or demonstrated
- **fact**: user personal facts (identity, interests, background, goals)
- **progress**: significant project milestones or completions

Return ONLY XML. Each observation must be wrapped in <observation>...</observation> blocks.
If there is nothing durable to record, return an empty response.

<observed_from_primary_session>
  <user_request>{user_request}</user_request>
  <requested_at>{today}</requested_at>
</observed_from_primary_session>

<observation>
  <type>discovery | lesson | convention | preference | fact | progress</type>
  <title>Brief title summarizing the finding (max 80 chars)</title>
  <subtitle>Optional additional context (max 120 chars)</subtitle>
  <facts>
    <fact>A specific, standalone fact statement</fact>
    <fact>Another fact statement</fact>
  </facts>
  <narrative>A concise paragraph describing what was learned and why it matters</narrative>
  <concepts>
    <concept>keyword-tag</concept>
    <concept>another-tag</concept>
  </concepts>
  <files_read>
    <file>path/to/read/file</file>
  </files_read>
  <files_modified>
    <file>path/to/modified/file</file>
  </files_modified>
</observation>

Guidelines:
- Title and narrative are required for every observation
- Facts should be standalone, verifiable statements (3-7 facts per observation)
- Concepts should be lowercase, kebab-case keywords for indexing
- Only list files you actually observe being read or modified
- Skip conversational turns that contain only greetings, status checks, or trivial questions
- NEVER include prose explanations outside of XML tags
- An empty response is valid and preferred over a forced observation`
}

export function buildObserverContinuationPrompt(userRequest: string): string {
  const today = new Date().toISOString().split("T")[0]
  return `Continue observing the JYYCode session.

<observed_from_primary_session>
  <user_request>${userRequest}</user_request>
  <requested_at>${today}</requested_at>
</observed_from_primary_session>

Analyze the user's request above and the assistant's full response. Extract structured observations using the same XML format as before.

Return ONLY <observation>...</observation> blocks. Empty response if nothing durable.`
}

export function buildObservationPrompt(opts: {
  toolName: string
  toolInput: unknown
  toolOutput: unknown
  timestamp: number
  cwd?: string
}): string {
  const when = new Date(opts.timestamp).toISOString()
  return `<observed_from_primary_session>
  <what_happened>${opts.toolName}</what_happened>
  <occurred_at>${when}</occurred_at>${opts.cwd ? `\n  <working_directory>${opts.cwd}</working_directory>` : ""}
  <parameters>${truncateField(opts.toolInput)}</parameters>
  <outcome>${truncateField(opts.toolOutput)}</outcome>
</observed_from_primary_session>

If a <parameters> or <outcome> block above contains an "<elided chars=... />" marker, that field was truncated to fit the context window. Describe only what you can see in the kept portion.

Analyze the tool execution above and return one or more <observation> blocks, or an empty response if this tool call produced no durable knowledge.
Concrete debugging findings, configuration discoveries, user preferences revealed, bugs found and fixed, and project structure insights all count as durable and should be recorded.
Never reply with prose such as "Skipping" or "No substantive tool executions". Non-XML text is discarded.`
}

function extractTag(text: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i")
  const match = text.match(pattern)
  return match?.[1]?.trim() || null
}

function extractTags(text: string, tag: string): string[] {
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gi")
  const results: string[] = []
  let match
  while ((match = pattern.exec(text)) !== null) {
    const content = match[1]?.trim()
    if (content) results.push(content)
  }
  return results
}

function extractListItems(text: string, tag: string): string[] {
  const block = extractTag(text, tag)
  if (!block) return []
  const items: string[] = []
  const pattern = new RegExp(`<${tag.replace(/s$/, "")}>([\\s\\S]*?)</${tag.replace(/s$/, "")}>`, "gi")
  let match
  while ((match = pattern.exec(block)) !== null) {
    const item = match[1]?.trim()
    if (item) items.push(item)
  }
  return items
}

export function parseObserverResponse(xml: string): ParsedObservation[] {
  if (!xml || !xml.trim()) return []

  const obsBlocks = extractTags(xml, "observation")
  const results: ParsedObservation[] = []

  for (const block of obsBlocks) {
    try {
      const type = extractTag(block, "type") || "discovery"
      const title = extractTag(block, "title")
      const subtitle = extractTag(block, "subtitle")
      const narrative = extractTag(block, "narrative")
      const facts = extractListItems(block, "facts")
      const concepts = extractListItems(block, "concepts")
      const files_read = extractListItems(block, "files_read")
      const files_modified = extractListItems(block, "files_modified")

      if (!title && !narrative) continue
      if (facts.length === 0 && !narrative) continue

      results.push({
        type: type.toLowerCase(),
        title: title ? title.slice(0, 200) : null,
        subtitle: subtitle ? subtitle.slice(0, 300) : null,
        facts,
        concepts: concepts.map((c) => c.toLowerCase().replace(/\s+/g, "-").slice(0, 60)),
        narrative: narrative ? narrative.slice(0, 2000) : null,
        files_read,
        files_modified,
      })
    } catch (err) {
      log.warn("failed to parse observation block", { error: String(err), block: block.slice(0, 200) })
    }
  }

  return results
}

export function parseSummaryResponse(xml: string): {
  request: string | null
  investigated: string | null
  learned: string | null
  completed: string | null
  next_steps: string | null
  notes: string | null
} | null {
  if (!xml || !xml.trim()) return null

  const summaryBlock = extractTag(xml, "summary")
  if (!summaryBlock) return null

  return {
    request: extractTag(summaryBlock, "request"),
    investigated: extractTag(summaryBlock, "investigated"),
    learned: extractTag(summaryBlock, "learned"),
    completed: extractTag(summaryBlock, "completed"),
    next_steps: extractTag(summaryBlock, "next_steps"),
    notes: extractTag(summaryBlock, "notes"),
  }
}
