/**
 * Apply basic syntax highlighting to code.
 * Returns HTML string with highlighted spans.
 * For production, integrate with Shiki or highlight.js.
 */
export function highlightCode(code: string, language: string): string {
  const escaped = escapeHTML(code)

  // Generic keyword highlighting (works for most languages)
  const keywords = [
    'import', 'export', 'from', 'const', 'let', 'var', 'function',
    'return', 'if', 'else', 'for', 'while', 'class', 'extends',
    'new', 'this', 'super', 'try', 'catch', 'throw', 'async', 'await',
    'type', 'interface', 'enum', 'implements', 'abstract',
    'public', 'private', 'protected', 'readonly', 'static',
    'true', 'false', 'null', 'undefined', 'void',
  ]

  let highlighted = escaped

  // Highlight strings
  highlighted = highlighted.replace(/(["'`])(?:(?!\1).)*?\1/g, '<span class="hl-string">$&</span>')

  // Highlight comments (// and /* */)
  highlighted = highlighted.replace(/(\/\/.*)$/gm, '<span class="hl-comment">$1</span>')
  highlighted = highlighted.replace(/(\/\*[\s\S]*?\*\/)/g, '<span class="hl-comment">$1</span>')

  // Highlight keywords
  const keywordPattern = new RegExp(`\\b(${keywords.join('|')})\\b`, 'g')
  highlighted = highlighted.replace(keywordPattern, '<span class="hl-keyword">$1</span>')

  // Highlight numbers
  highlighted = highlighted.replace(/\b(\d+\.?\d*)\b/g, '<span class="hl-number">$1</span>')

  return highlighted
}

function escapeHTML(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
