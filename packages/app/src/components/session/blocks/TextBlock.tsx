import type { TextPart } from '../../../types/models'

interface Props {
  part: TextPart
}

// Simple Markdown-to-HTML renderer (inline, no external deps)
function renderMarkdown(md: string): string {
  // Basic Markdown rendering (production would use marked or similar)
  return md
    .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
    .replace(/`([^`]+)`/g, '<code style="background:rgba(0,0,0,0.06);padding:1px 4px;border-radius:3px;font-size:14px;">$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^### (.+)$/gm, '<h4 style="font-size:17px;font-weight:600;margin:12px 0 4px;">$1</h4>')
    .replace(/^## (.+)$/gm, '<h3 style="font-size:21px;font-weight:600;margin:16px 0 8px;">$1</h3>')
    .replace(/^# (.+)$/gm, '<h2 style="font-size:28px;font-weight:400;margin:20px 0 10px;">$1</h2>')
    .replace(/^- (.+)$/gm, '<li style="margin-left:20px;">$1</li>')
    .replace(/\n/g, '<br/>')
}

export function TextBlock(props: Props) {
  return (
    <div
      class="text-body"
      style={{
        color: 'var(--color-text-primary)',
        'word-break': 'break-word',
      }}
      innerHTML={renderMarkdown(props.part.content)}
    />
  )
}
