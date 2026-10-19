import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import {
  collectInjectedInputIds,
  findLatestTurnMessageId,
  getInjectedInput,
  groupArchivedSteers,
} from './steer-message';

const textMessage = (
  id: string,
  role: UIMessage['role'],
  text: string,
  metadata?: Record<string, unknown>,
): UIMessage => ({
  id,
  role,
  metadata,
  parts: [{ type: 'text', text }],
});

describe('steer message presentation', () => {
  it('finds the ordinary user message that owns the active turn', () => {
    const messages = [
      textMessage('user-1', 'user', 'Start'),
      textMessage('steer-1', 'user', 'Adjust', { steer: true }),
      textMessage('assistant-1', 'assistant', 'Working'),
    ];

    expect(findLatestTurnMessageId(messages)).toBe('user-1');
  });

  it('attaches steer messages to the user message that owns their turn', () => {
    const messages = [
      textMessage('user-1', 'user', 'Start'),
      textMessage('steer-1', 'user', 'First adjustment', {
        steer: true,
        turnMessageId: 'user-1',
      }),
      textMessage('steer-2', 'user', 'Second adjustment', {
        steer: true,
        turnMessageId: 'user-1',
      }),
      textMessage('assistant-1', 'assistant', 'First assistant segment'),
      textMessage('assistant-2', 'assistant', 'Final assistant segment'),
    ];

    const presentation = groupArchivedSteers(messages);

    expect(presentation.messages.map((message) => message.id)).toEqual([
      'user-1',
      'assistant-1',
      'assistant-2',
    ]);
    expect(
      presentation.steersByUserMessageId
        .get('user-1')
        ?.map((message) => message.id),
    ).toEqual(['steer-1', 'steer-2']);
  });

  it('uses adjacency for legacy steer messages and keeps rows visible when their user is missing', () => {
    const attached = groupArchivedSteers([
      textMessage('user-1', 'user', 'Start'),
      textMessage('steer-1', 'user', 'Legacy adjustment', { steer: true }),
      textMessage('assistant-1', 'assistant', 'Done'),
    ]);
    expect(attached.messages.map((message) => message.id)).toEqual(['user-1', 'assistant-1']);
    expect(attached.steersByUserMessageId.get('user-1')?.[0]?.id).toBe('steer-1');

    const orphaned = groupArchivedSteers([
      textMessage('steer-1', 'user', 'Its owning user is outside this page', {
        steer: true,
        turnMessageId: 'user-1',
      }),
    ]);
    expect(orphaned.messages.map((message) => message.id)).toEqual(['steer-1']);
    expect(orphaned.steersByUserMessageId.size).toBe(0);
  });

  it('drops a steer the reply already shows where the agent read it', () => {
    const reply: UIMessage = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Before' },
        { type: 'data-injected-input', id: 'steer-1', data: { id: 'steer-1', text: 'Shown inline' } },
        { type: 'text', text: 'After' },
      ],
    };
    const messages = [
      textMessage('user-1', 'user', 'Start'),
      textMessage('steer-1', 'user', 'Shown inline', { steer: true, turnMessageId: 'user-1' }),
      textMessage('steer-2', 'user', 'Never read', { steer: true, turnMessageId: 'user-1' }),
      reply,
    ];

    expect(collectInjectedInputIds(messages)).toEqual(new Set(['steer-1']));
    expect(getInjectedInput(reply.parts[1])).toEqual({ id: 'steer-1', text: 'Shown inline' });
    const presentation = groupArchivedSteers(messages);
    expect(presentation.messages.map((message) => message.id)).toEqual(['user-1', 'assistant-1']);
    // A provider that cannot say when it read one still gets the old placement.
    expect(presentation.steersByUserMessageId.get('user-1')?.map((message) => message.id)).toEqual(['steer-2']);
  });
});
