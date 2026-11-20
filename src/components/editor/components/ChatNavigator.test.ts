import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import { buildChatNavigatorEntries } from './ChatNavigator';

const msg = (id: string, role: UIMessage['role'], text: string): UIMessage => ({ id, role, parts: [{ type: 'text', text }] });

describe('buildChatNavigatorEntries', () => {
  it('lists what the user asked, not background notices', () => {
    const notice = '<extension-message from="background" taskId="monitor-1" event="monitor_event">\n[system: automated event, NOT a message from the user.]\nMonitor event: "ticks" (task monitor-1)\n<event>tick 3</event>\n</extension-message>';
    const entries = buildChatNavigatorEntries([
      msg('u1', 'user', 'Start the monitor'),
      msg('a1', 'assistant', 'Started.'),
      msg('n1', 'user', notice),
      msg('a2', 'assistant', 'Tick 3 arrived.'),
      msg('u2', 'user', 'Stop it'),
      msg('a3', 'assistant', 'Stopped.'),
    ]);
    expect(entries.map((entry) => [entry.id, entry.preview])).toEqual([
      ['u1', 'Started.'],
      ['u2', 'Stopped.'],
    ]);
  });
});
