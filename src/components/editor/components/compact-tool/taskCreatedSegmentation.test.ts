import { describe, it, expect } from 'vitest';
import { isCompactEligible } from './isCompactEligible';
import { segmentMessageParts } from './segmentParts';
import { createdTaskNumber } from '../TaskCreatedRenderer';
import type { ToolPartLike } from '../toolName';

/**
 * A successful task-creating call has to escape the collapsed work group,
 * otherwise it renders as a one-line summary and MessagePartRenderer's card
 * branch is never reached — which is exactly how the card silently went missing.
 *
 * The inverse matters just as much: a failed or still-streaming call must stay
 * in the group, because the renderer returns null for those and the part would
 * disappear from the transcript instead of falling back.
 */

const createCall = (overrides: Record<string, unknown> = {}): ToolPartLike =>
  ({
    type: 'dynamic-tool',
    toolName: 'mcp__taskboard__create_spec_task',
    state: 'output-available',
    ...overrides,
  }) as ToolPartLike;

const withText = (text: string) => createCall({ output: { content: [{ type: 'text', text }] } });

const withStructured = (structuredContent: unknown) => createCall({ output: { structuredContent } });

const withDirectOutput = (output: unknown) => createCall({ output });

describe('createdTaskNumber — ACP `use_tool` envelope', () => {
  /**
   * Verbatim from a stored transcript (chat 591). Grok/Cursor over ACP route
   * every call through `use_tool`, so the outer toolName says nothing about what
   * ran, the real name is in `input.tool_name`, and the result is `{output}`
   * with no structuredContent. This shape is why the card never appeared.
   */
  const realEnvelope = {
    type: 'dynamic-tool',
    toolName: 'use_tool',
    toolCallId: 'call-0a2ab270-6279-4ec5-b843-1410cfb40d96-2',
    state: 'output-available',
    input: {
      tool_name: 'taskboard__create_spec_task',
      tool_input: {
        title: 'Spec workflow smoke test',
        description: 'Smoke test for the SDD/spec task pipeline.',
      },
    },
    output: {
      output:
        'Promoted to task #15 (branch operon/task-15). You are now the spec author for this change.',
    },
    providerExecuted: true,
  } as unknown as ToolPartLike;

  it('recognises the task through the envelope', () => {
    expect(createdTaskNumber(realEnvelope)).toBe(15);
  });

  it('pulls it out of the collapsed work group', () => {
    expect(isCompactEligible(realEnvelope)).toBe(false);
  });

  it('does not claim an unrelated tool sent through the same envelope', () => {
    const other = {
      ...realEnvelope,
      input: { tool_name: 'taskboard__write_artifact', tool_input: { task: 15 } },
    } as unknown as ToolPartLike;
    expect(createdTaskNumber(other)).toBeNull();
  });
});

describe('createdTaskNumber', () => {
  it('reads a Claude Code outputSchema result emitted directly as output', () => {
    const call = withDirectOutput({
      kind: 'created-task',
      taskId: 18,
      taskNumber: 16,
      title: 'SDD smoke test: two team-coordinated subtasks',
      sddManaged: true,
    });

    expect(createdTaskNumber(call)).toBe(16);
    expect(isCompactEligible(call)).toBe(false);
  });

  it('reads the number out of structuredContent', () => {
    expect(
      createdTaskNumber(
        withStructured({
          kind: 'created-task',
          taskId: 42,
          taskNumber: 15,
          title: 'Smoke test',
          sddManaged: true,
        }),
      ),
    ).toBe(15);
  });

  it('falls back to the prose for transcripts without structuredContent', () => {
    expect(createdTaskNumber(withText('Created task #15: Smoke test'))).toBe(15);
    expect(createdTaskNumber(withText('Promoted to task #7 (branch feat/x)'))).toBe(7);
  });

  it('unwraps the MCP gateway envelope', () => {
    expect(
      createdTaskNumber(
        createCall({ output: { server: 'taskboard', result: { content: [{ text: 'Created task #9' }] } } }),
      ),
    ).toBe(9);
  });

  it('returns null for a failure that merely mentions a number', () => {
    expect(createdTaskNumber(withText('Could not promote: Channel 1 does not have a task'))).toBeNull();
  });

  it('returns null while the call is still streaming', () => {
    expect(createdTaskNumber(createCall({ state: 'input-streaming' }))).toBeNull();
  });

  it('ignores tools that do not create tasks', () => {
    expect(
      createdTaskNumber(
        createCall({
          toolName: 'mcp__taskboard__write_artifact',
          output: { content: [{ text: 'Created task #15' }] },
        }),
      ),
    ).toBeNull();
  });
});

describe('isCompactEligible — task creation', () => {
  it('excludes a successful create so it can render as a card', () => {
    expect(isCompactEligible(withText('Created task #15: Smoke test'))).toBe(false);
  });

  it('keeps a failed create compact so it still renders as a tool row', () => {
    expect(isCompactEligible(withText('Could not promote: no such channel'))).toBe(true);
  });

  it('keeps a streaming create compact', () => {
    expect(isCompactEligible(createCall({ state: 'input-streaming' }))).toBe(true);
  });

  it('leaves other taskboard tools compact', () => {
    expect(isCompactEligible(createCall({ toolName: 'mcp__taskboard__write_artifact' }))).toBe(true);
  });
});

describe('segmentMessageParts — task creation', () => {
  it('breaks a successful create out of the surrounding work run', () => {
    const parts = [
      { type: 'reasoning', text: 'thinking' },
      withText('Created task #15: Smoke test'),
      { type: 'dynamic-tool', toolName: 'mcp__taskboard__write_artifact', state: 'output-available' },
    ] as unknown as Parameters<typeof segmentMessageParts>[0];

    expect(segmentMessageParts(parts, new Set())).toEqual([
      { type: 'tool-group', partIndices: [0] },
      { type: 'single', partIndex: 1 },
      { type: 'tool-group', partIndices: [2] },
    ]);
  });

  it('keeps a failed create inside the work run', () => {
    const parts = [
      { type: 'reasoning', text: 'thinking' },
      withText('Could not promote: no such channel'),
    ] as unknown as Parameters<typeof segmentMessageParts>[0];

    expect(segmentMessageParts(parts, new Set())).toEqual([
      { type: 'tool-group', partIndices: [0, 1] },
    ]);
  });
});
