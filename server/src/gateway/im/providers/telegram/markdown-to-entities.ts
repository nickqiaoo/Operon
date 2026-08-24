import { marked, type Token, type TokensList, type Tokens } from 'marked'

const HTML_ENTITY_RE = /&(?:amp|lt|gt|quot|#39|apos|#x27|nbsp);/g
const HTML_ENTITY_MAP: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&#x27;': "'", '&nbsp;': ' ',
}
function decodeHtmlEntities(text: string): string {
  return text.replace(HTML_ENTITY_RE, (m) => HTML_ENTITY_MAP[m] ?? m)
}

export interface MessageEntity {
  type: string
  offset: number
  length: number
  url?: string
  language?: string
}

export interface ParseResult {
  text: string
  entities: MessageEntity[]
}

export function markdownToTelegramEntities(markdownText: string): ParseResult {
  const tokens = marked.lexer(markdownText, { gfm: true, breaks: true })

  let plainText = ''
  const entities: MessageEntity[] = []

  function processTokens(tokenList: Token[] | TokensList | undefined) {
    if (!tokenList) return

    const iterableTokens = Array.isArray(tokenList) ? tokenList : []

    for (const token of iterableTokens) {
      const startOffset = plainText.length

      let entityType: string | null = null
      const entityProps: Partial<MessageEntity> = {}

      switch (token.type) {
        case 'paragraph':
          processTokens((token as Tokens.Paragraph).tokens)
          if (iterableTokens.indexOf(token) < iterableTokens.length - 1) {
            plainText += '\n\n'
          }
          break
        case 'strong':
          entityType = 'bold'
          processTokens((token as Tokens.Strong).tokens)
          break
        case 'em':
          entityType = 'italic'
          processTokens((token as Tokens.Em).tokens)
          break
        case 'del':
          entityType = 'strikethrough'
          processTokens((token as Tokens.Del).tokens)
          break
        case 'codespan':
          entityType = 'code'
          plainText += decodeHtmlEntities((token as Tokens.Codespan).text)
          break
        case 'code': {
          entityType = 'pre'
          const codeToken = token as Tokens.Code
          entityProps.language = codeToken.lang?.trim() || ''
          let codeText = codeToken.text
          codeText = codeText.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
          plainText += codeText
          break
        }
        case 'link': {
          const linkToken = token as Tokens.Link
          const href = linkToken.href
          // Only emit text_link for valid http(s) URLs — local paths,
          // bare filenames, etc. would be rejected by Telegram.
          if (href && /^https?:\/\//i.test(href)) {
            entityType = 'text_link'
            entityProps.url = href
          }
          processTokens(linkToken.tokens)
          break
        }
        case 'blockquote': {
          entityType = 'blockquote'
          const bqToken = token as Tokens.Blockquote
          if (bqToken.tokens) {
            const childTokens = bqToken.tokens
            childTokens.forEach((childToken: Token, index: number) => {
              const textBeforeChild = plainText
              processTokens([childToken])
              if (
                plainText.length > textBeforeChild.length &&
                index < childTokens.length - 1
              ) {
                const nextToken = childTokens[index + 1]
                if (
                  nextToken &&
                  ['paragraph', 'list', 'blockquote', 'code', 'heading'].includes(nextToken.type)
                ) {
                  plainText += '\n'
                }
              }
            })
          }
          break
        }
        case 'list': {
          const listToken = token as Tokens.List
          if (plainText && !plainText.endsWith('\n')) {
            plainText += '\n'
          }
          const before = plainText.length
          listToken.items.forEach((item, index) => {
            plainText += listToken.ordered ? `${index + 1}. ` : '\u2022  '
            processTokens(item.tokens)
            plainText = plainText.replace(/\n+$/, '')
            plainText += '\n'
          })
          if (plainText.length > before) {
            plainText = plainText.replace(/\n$/, '\n\n')
          }
          plainText = plainText.replace(/\n{3,}/g, '\n\n')
          break
        }
        case 'heading':
          entityType = 'bold'
          processTokens((token as Tokens.Heading).tokens)
          if (iterableTokens.indexOf(token) < iterableTokens.length - 1) {
            plainText += '\n\n'
          }
          break
        case 'hr':
          break
        case 'br':
          plainText += '\n'
          break
        case 'text':
          if ((token as Tokens.Text).tokens) {
            processTokens((token as Tokens.Text).tokens)
          } else {
            plainText += (token as Tokens.Text).text
          }
          break
        case 'html':
        case 'space':
          break
        default:
          if ('tokens' in token && token.tokens && Array.isArray(token.tokens)) {
            processTokens(token.tokens)
          } else if ('text' in token && typeof token.text === 'string') {
            plainText += token.text
          }
          break
      }

      if (entityType) {
        const currentTextLength = plainText.length - startOffset
        if (currentTextLength > 0) {
          entities.push({
            type: entityType,
            offset: startOffset,
            length: currentTextLength,
            ...entityProps,
          } as MessageEntity)
        }
      }
    }
  }

  processTokens(tokens)
  return { text: plainText, entities }
}
