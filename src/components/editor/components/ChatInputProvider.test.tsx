// @vitest-environment jsdom
import { act, useCallback } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usePromptInputController, type PromptInputControllerProps } from '@/components/ai-elements/prompt-input-context';
import { claimChatInput, clearChatDraft, getChatDraft, getChatDraftSkills, setChatDraftSkills } from '@/lib/chat-drafts';
import type { SlashCommandItem } from '../hooks/useModelManagement';
import { ChatInputProvider } from './ChatInputProvider';
import { useSlashCommand } from './useSlashCommand';

let root: Root;
let container: HTMLDivElement;
let controller: PromptInputControllerProps;
let skillsApi: ReturnType<typeof useSlashCommand>;
let blobCount = 0;
const revoked: string[] = [];

const skill: SlashCommandItem = { name: 'review', type: 'skill', description: '' };

// Wired the way ChatPanel / ChatInputArea are.
function Composer({ chatId }: { chatId: string }) {
  controller = usePromptInputController();
  const saveSkills = useCallback((skills: SlashCommandItem[]) => setChatDraftSkills(chatId, skills), [chatId]);
  skillsApi = useSlashCommand({
    input: controller.textInput.value,
    setInput: controller.textInput.setInput,
    cursorPos: 0,
    slashCommands: [],
    initialSkills: getChatDraftSkills(chatId),
    onSkillsChange: saveSkills,
  });
  return <span>{controller.textInput.value}</span>;
}

async function show(chatId: string) {
  await act(async () => {
    root.render(<ChatInputProvider key={chatId} chatId={chatId}><Composer chatId={chatId} /></ChatInputProvider>);
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  revoked.length = 0;
  // jsdom has no blob URLs.
  Object.assign(URL, {
    createObjectURL: () => `blob:test-${++blobCount}`,
    revokeObjectURL: (url: string) => { revoked.push(url); },
  });
  clearChatDraft('chat-a');
  clearChatDraft('chat-b');
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('chat input memory drafts', () => {
  it('restores independent drafts after workspace composers unmount', async () => {
    await show('chat-a');
    await act(async () => controller.textInput.setInput('Draft A'));
    await show('chat-b');
    expect(container.textContent).toBe('');
    await act(async () => controller.textInput.setInput('Draft B'));
    await show('chat-a');
    expect(container.textContent).toBe('Draft A');
    await show('chat-b');
    expect(container.textContent).toBe('Draft B');
  });

  it('keeps submitted or manually cleared text empty on return', async () => {
    await show('chat-a');
    await act(async () => controller.textInput.setInput('To send'));
    await act(async () => controller.textInput.clear());
    await show('chat-b');
    await show('chat-a');
    expect(container.textContent).toBe('');
    await act(async () => controller.textInput.setInput('To delete'));
    await act(async () => controller.textInput.setInput(''));
    await show('chat-b');
    await show('chat-a');
    expect(container.textContent).toBe('');
  });

  it('does not reapply an old prefill over edited or submitted drafts', async () => {
    await show('chat-a');
    expect(claimChatInput('chat-a', 'prefill-1')).toBe(true);
    await act(async () => controller.textInput.setInput('Edited prefill'));
    await show('chat-b');
    await show('chat-a');
    expect(claimChatInput('chat-a', 'prefill-1')).toBe(false);
    expect(getChatDraft('chat-a')).toBe('Edited prefill');
    await act(async () => controller.textInput.clear());
    expect(claimChatInput('chat-a', 'prefill-1')).toBe(false);
    expect(claimChatInput('chat-a', 'prefill-2')).toBe(true);
  });

  it('keeps pasted images alive across unmounts and revokes them when the draft is dropped', async () => {
    await show('chat-a');
    await act(async () => controller.attachments.add([new File(['png'], 'shot.png', { type: 'image/png' })]));
    const [pasted] = controller.attachments.files;

    await show('chat-b');
    expect(controller.attachments.files).toEqual([]);
    expect(revoked).toEqual([]);

    await show('chat-a');
    expect(controller.attachments.files).toEqual([pasted]);

    await show('chat-b');
    clearChatDraft('chat-a');
    expect(revoked).toEqual([pasted.url]);
    await show('chat-a');
    expect(controller.attachments.files).toEqual([]);
  });

  it('does not restore attachments that were sent or removed', async () => {
    await show('chat-a');
    await act(async () => controller.attachments.add([new File(['a'], 'a.png', { type: 'image/png' })]));
    await act(async () => controller.attachments.clear());
    await show('chat-b');
    await show('chat-a');
    expect(controller.attachments.files).toEqual([]);
  });

  it('restores selected skill chips and forgets them after submit', async () => {
    await show('chat-a');
    await act(async () => skillsApi.addSkill(skill));
    await show('chat-b');
    expect(skillsApi.selectedSkills).toEqual([]);
    await show('chat-a');
    expect(skillsApi.selectedSkills).toEqual([skill]);

    await act(async () => skillsApi.clearSkills());
    await show('chat-b');
    await show('chat-a');
    expect(skillsApi.selectedSkills).toEqual([]);
  });
});
