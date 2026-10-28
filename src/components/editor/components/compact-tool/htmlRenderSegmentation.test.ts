import { describe, it, expect } from 'vitest';
import type { UIMessage } from 'ai';
import { segmentMessageParts } from './segmentParts';
import { isCompactEligible } from './isCompactEligible';
import { isHtmlRenderResult } from '../HtmlRenderFrame';
import type { ToolPartLike } from '../toolName';

type MessagePart = UIMessage['parts'][number];

const url = `/api/attachments/${'a'.repeat(64)}`;
const published = JSON.stringify({ visual: { url, title: 'broker → node', height: 1180 }, message: 'Shown' });

// Shapes as stored for an OpenCode (DeepSeek) turn: `execute` program, nested call tagged with its id.
const read = { type: 'dynamic-tool', toolName: 'read', toolCallId: 'r1', state: 'output-available', input: { filePath: '/a' }, output: 'x' };
const program = { type: 'dynamic-tool', toolName: 'execute', toolCallId: 'p1', state: 'output-available', input: { code: 'await tools.visual.html_render(...)' }, output: 'rendered' };
const render = (output: unknown) => ({
  type: 'dynamic-tool',
  toolName: 'visual_html_render',
  toolCallId: 'p1/1',
  state: 'output-available',
  input: { html: '<p>', title: 't', height: 1180 },
  output,
  callProviderMetadata: { opencode: { programToolCallId: 'p1' } },
});

const segment = (parts: unknown[]) => segmentMessageParts(parts as MessagePart[], new Set([parts.length - 1]));

describe('html_render', () => {
  it('is recognised under every client prefix and leaves the work group', () => {
    for (const toolName of ['visual_html_render', 'mcp__visual__html_render']) {
      const part = { ...render(published), toolName } as ToolPartLike;
      expect(isHtmlRenderResult(part)).toBe(true);
      expect(isCompactEligible(part)).toBe(false);
    }
  });

  it('reads the structured output Claude Code stores in place of the text', () => {
    const part = { ...render(JSON.parse(published)), toolName: 'mcp__visual__html_render' } as ToolPartLike;
    expect(isHtmlRenderResult(part)).toBe(true);
    expect(isCompactEligible(part)).toBe(false);
  });

  it('stays a compact row while it has no page', () => {
    for (const output of [undefined, 'These image paths are not readable image files: /x.png']) {
      const part = render(output) as ToolPartLike;
      expect(isHtmlRenderResult(part)).toBe(false);
      expect(isCompactEligible(part)).toBe(true);
    }
  });

  it('folds the program with the other work and shows its page on its own', () => {
    // MessagesList leaves a published page out of the program's children.
    const parts = [read, program, render(published)] as MessagePart[];
    expect(segmentMessageParts(parts, new Set())).toEqual([
      { type: 'tool-group', partIndices: [0, 1] },
      { type: 'single', partIndex: 2 },
    ]);
  });

  it('keeps a program whose calls are all routine in the group', () => {
    expect(segment([read, program, render(undefined)])).toEqual([
      { type: 'tool-group', partIndices: [0, 1] },
    ]);
  });
});
