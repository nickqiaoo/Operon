import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { isCodeProgramTool, programToolCallIdOf } from './codeProgram';
import { isCompactEligible } from './compact-tool/isCompactEligible';
import { MessagePartRenderer } from './MessagePartRenderer';
import type { ToolPartLike } from './toolName';

type Part = UIMessage['parts'][number];

const tool = (fields: Record<string, unknown>): Part => ({ type: 'dynamic-tool', ...fields }) as unknown as Part;
const nested = (toolCallId: string, fields: Record<string, unknown>) =>
  tool({ toolCallId, callProviderMetadata: { operon: { programToolCallId: 'run-1' } }, ...fields });

describe('Code Mode program parts', () => {
  it('recognises RunCode and OpenCode execute, but not another tool named execute', () => {
    expect(isCodeProgramTool({ toolName: 'RunCode', input: { code: 'return 1', description: 'x' } })).toBe(true);
    expect(isCodeProgramTool({ toolName: 'execute', input: { code: 'return 1' } })).toBe(true);
    expect(isCodeProgramTool({ toolName: 'execute', input: { command: 'ls' } })).toBe(false);
    expect(isCompactEligible({ toolName: 'RunCode', input: {} } as ToolPartLike)).toBe(false);
  });

  it('reads the program a call belongs to from any provider key', () => {
    expect(programToolCallIdOf(nested('a', { toolName: 'Read' }))).toBe('run-1');
    expect(programToolCallIdOf(tool({ toolCallId: 'b', callProviderMetadata: { opencode: { programToolCallId: 'execute-1' } } }))).toBe('execute-1');
    expect(programToolCallIdOf(tool({ toolCallId: 'c', callProviderMetadata: { opencode: { parentToolCallId: 'task-1' } } }))).toBeNull();
  });

  it('keeps cards and pending approvals in sight while the program card is folded', () => {
    const program = tool({
      toolCallId: 'run-1',
      toolName: 'RunCode',
      state: 'input-available',
      input: { code: 'await tools.Read({ path: "a" })', description: 'Schedule the digest' },
    });
    const children = [
      nested('run-1:code:1', { toolName: 'Read', state: 'output-available', input: { file_path: '/tmp/notes.md' }, output: 'hello' }),
      nested('run-1:code:2', {
        toolName: 'mcp__schedule__schedule_create',
        state: 'output-available',
        input: { name: 'PR digest' },
        output: JSON.stringify({ task: { id: 9, name: 'PR digest', enabled: true } }),
      }),
      nested('run-1:code:3', { toolName: 'Bash', state: 'approval-requested', input: { command: 'rm -rf build' }, approval: { id: 'approval-1' } }),
    ];
    const message: UIMessage = { id: 'm1', role: 'assistant', parts: [program, ...children] };
    const html = renderToStaticMarkup(
      <IntlProvider locale="en">
        <MessagePartRenderer
          message={message}
          part={program}
          partIndex={0}
          isStreamingMessage
          onPermissionDecide={async () => true}
          onCopy={() => undefined}
          onSendTo={() => undefined}
          availableModels={[]}
          getMessageText={() => ''}
          firstAttachmentIndex={-1}
          attachmentParts={[]}
          lastTextPartIndex={-1}
          SendToButton={() => <></>}
          childParts={children}
        />
      </IntlProvider>,
    );

    expect(html).toContain('Schedule the digest');
    expect(html).toContain('3 calls');
    expect(html).toContain('Needs approval');
    // The schedule card and the approval prompt render outside the fold.
    expect(html).toContain('PR digest');
    expect(html).toContain('rm -rf build');
    expect(html).toContain('requests permission');
    // The routine read is folded away with the source.
    expect(html).not.toContain('notes.md');
    expect(html).not.toContain('program.ts');
  });
});
