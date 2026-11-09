// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { PromptInputProvider, usePromptInputActions, usePromptInputController, type PromptInputActionsProps } from './prompt-input-context';

it('reads input synchronously while keeping actions and their consumers stable during typing', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  let actions!: PromptInputActionsProps;
  let renders = 0;
  let value = '';
  function Actions() {
    actions = usePromptInputActions();
    renders += 1;
    return null;
  }
  function Input() {
    value = usePromptInputController().textInput.value;
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<PromptInputProvider><Actions /><Input /></PromptInputProvider>));
    const original = actions;
    for (const text of ['h', 'hello']) {
      await act(async () => {
        actions.setInput(text);
        expect(actions.getInput()).toBe(text);
      });
      expect(value).toBe(text);
      expect(actions).toBe(original);
      expect(actions.setInput).toBe(original.setInput);
      expect(actions.getInput).toBe(original.getInput);
      expect(actions.attachments).toBe(original.attachments);
      expect(renders).toBe(1);
    }
  } finally {
    await act(async () => root.unmount());
  }
});
