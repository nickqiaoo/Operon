import type { Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { classifyMarkdownLines } from "./reply-images";

const parser = unified().use(remarkParse).use(remarkGfm);
const possibleHtml = /<\/?[a-z][a-z\d-]*(?=[\s/>])|<!--/i;
const inlineTag = /^<(\/?)(br|kbd|sub|sup|mark|u|s|small|span)(?:\s*\/?)>$/i;
const groupedBlock = /^<(details|div|table)\b/i;
const marker = "\uE000operon-html:";
const markerPattern = /\uE000operon-html:(\/?[a-z]+)\uE001/g;
const fence = "\x60".repeat(3);

interface Replacement {
  start: number;
  end: number;
  value: string;
}

function offsets(node: RootContent) {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start !== undefined && end !== undefined ? { start, end } : null;
}

function collectInline(node: RootContent, replacements: Replacement[]) {
  if (node.type === "html") {
    const match = inlineTag.exec(node.value);
    const position = offsets(node);
    if (match && position) {
      replacements.push({ ...position, value: marker + match[1] + match[2].toLowerCase() + "\uE001" });
    }
    return;
  }
  if ("children" in node) {
    for (const child of node.children) collectInline(child, replacements);
  }
}

/** Carry safely supported HTML through Words as ordinary block and inline slots. */
export function prepareMarkdownHtml(source: string) {
  if (!possibleHtml.test(source) || !classifyMarkdownLines(source).some(({ line, prose }) => prose && possibleHtml.test(line))) {
    return source;
  }
  const { children } = parser.parse(source) as Root;
  const replacements: Replacement[] = [];
  for (let index = 0; index < children.length; index++) {
    const node = children[index];
    if (node.type !== "html") {
      collectInline(node, replacements);
      continue;
    }
    const position = offsets(node);
    if (!position) continue;
    const tag = groupedBlock.exec(node.value)?.[1];
    if (tag) {
      const closing = new RegExp("</" + tag + "\\s*>", "i");
      if (!closing.test(node.value)) {
        const close = children.findIndex((child, at) => at > index && child.type === "html" && closing.test(child.value));
        const end = close > index ? offsets(children[close])?.end : undefined;
        if (end !== undefined) {
          position.end = end;
          index = close;
        }
      }
    }
    const value = JSON.stringify(source.slice(position.start, position.end));
    replacements.push({ ...position, value: "\n\n" + fence + "operon-html\n" + value + "\n" + fence + "\n\n" });
  }
  let result = "";
  let cursor = 0;
  for (const part of replacements) {
    result += source.slice(cursor, part.start) + part.value;
    cursor = part.end;
  }
  return result + source.slice(cursor);
}

export function hasInlineMarkdownHtml(source: string) {
  return source.includes(marker);
}

export function restoreInlineHtml(text: string) {
  return text.replace(markerPattern, (original, name: string) => {
    const tag = "<" + name + ">";
    return inlineTag.test(tag) ? tag : original;
  });
}
