// Minimal markdown → Slack mrkdwn converter.
// Slack mrkdwn differs from standard markdown:
//   *bold* instead of **bold**
//   _italic_ is the same
//   `code` and ```code``` are the same
//   <url|text> instead of [text](url)
//   # headings are not supported; render as *bold* on its own line

export function markdownToMrkdwn(md: string): string {
  let out = md

  // Fenced code blocks — preserve as-is, protect from further rewrites.
  const codeBlocks: string[] = []
  out = out.replace(/```[\s\S]*?```/g, (block) => {
    codeBlocks.push(block)
    return `\x00CB${codeBlocks.length - 1}\x00`
  })

  // Inline code — preserve as-is, protect from further rewrites.
  const inlineCodes: string[] = []
  out = out.replace(/`[^`\n]+`/g, (code) => {
    inlineCodes.push(code)
    return `\x00IC${inlineCodes.length - 1}\x00`
  })

  // Links: [text](url) -> <url|text>
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, text: string, url: string) => {
    return `<${url}|${text}>`
  })

  // Bold: **text** or __text__ -> *text*
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, '*$1*')
  out = out.replace(/__([^_\n]+?)__/g, '*$1*')

  // Headings: lines starting with # (up to ######) -> *line* on same line
  out = out.replace(/^#{1,6}\s+(.+)$/gm, '*$1*')

  // Strikethrough: ~~text~~ -> ~text~ (Slack uses single tildes)
  out = out.replace(/~~([^~\n]+?)~~/g, '~$1~')

  // Restore inline code then code blocks
  out = out.replace(/\x00IC(\d+)\x00/g, (_, i: string) => inlineCodes[Number(i)] ?? '')
  out = out.replace(/\x00CB(\d+)\x00/g, (_, i: string) => codeBlocks[Number(i)] ?? '')

  return out
}
