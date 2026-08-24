import { useCallback, useEffect, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import type { ChatStatus } from 'ai';
import { BrainIcon, Loader2, MessageSquarePlus, PaperclipIcon, Target, Zap } from 'lucide-react';

import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from '@/components/ai-elements/prompt-input';
import { usePromptInputAttachments } from '@/components/ai-elements/prompt-input';
import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from '@/components/ai-elements/attachments';
import { cn } from '@/lib/utils';
import type { SlashCommandItem } from '../hooks/useModelManagement';
import { MentionPopup } from './MentionPopup';
import { ModelSelectorPanel, type DynamicModel } from './ModelSelectorPanel';
import { useMentionOverlay } from './useMentionOverlay';
import { useSlashCommand } from './useSlashCommand';
import { SlashCommandPopup } from './SlashCommandPopup';
import { SkillChips } from './SkillChips';
import { hasComposerDraft } from './chatInputState';

interface ChatInputAreaProps {
  input: string;
  setInput: (val: string) => void;
  attachments: ReturnType<typeof usePromptInputAttachments>;
  onSubmit: (message: PromptInputMessage) => void;
  status: ChatStatus;
  onStop: () => void;
  isGenerating: boolean;
  modeBorderClass: string;
  selectorOpen: boolean;
  setSelectorOpen: (open: boolean) => void;
  selectedModel: DynamicModel | undefined;
  availableModels: DynamicModel[];
  model: string;
  setModel: (id: string) => void;
  thinkingEffort: string;
  cycleThinkingEffort: () => void;
  thinkingEffortOptions: { value: string; label: string }[];
  modeOptions: { value: string; label: string; description?: string }[];
  currentMode: string;
  cycleMode: () => void;
  modeButtonClass?: string;
  serviceTierOptions: { value: string; label: string; description?: string }[];
  currentServiceTier: string;
  toggleFastMode: () => void;
  /** Whether the active provider supports thread goals (codex). */
  goalSupported?: boolean;
  /** Whether goal mode is armed — the next sent message starts a goal. */
  goalArmed?: boolean;
  /** Toggle goal mode on/off (does not send). */
  onToggleGoal?: () => void;
  slashCommands: SlashCommandItem[];
  /** When true, model/mode buttons remain clickable during generation (CC dynamic switch) */
  supportsDynamicSwitch?: boolean;
  canSteer?: boolean;
  steerPending?: boolean;
  onSteer?: (text: string) => Promise<void> | void;
  compactWhenIdle?: boolean;
  mobileKeyboardOpen?: boolean;
  /** Queued review comments or browser annotations sent with the next message. */
  hasPendingContext?: boolean;
}

function AttachmentButton() {
  const attachments = usePromptInputAttachments();
  return (
    <PromptInputButton
      // Marked so the mobile touch handlers leave this button's native tap
      // alone: opening a file picker needs a real user activation, which a
      // synthetic .click() dispatched from touchstart does not carry.
      data-composer-attach
      onClick={() => attachments.openFileDialog()}
      className="h-8 shrink-0 gap-1.5 rounded-full border border-transparent bg-muted/30 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-all hover:border-border/60 hover:bg-muted hover:text-foreground dark:hover:border-border/35"
    >
      <PaperclipIcon className="size-3.5" />
    </PromptInputButton>
  );
}

const btnCn =
  'h-8 shrink-0 gap-1.5 whitespace-nowrap rounded-full border border-transparent bg-muted/30 px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-all hover:border-border/60 hover:bg-muted hover:text-foreground dark:hover:border-border/35';

export function ChatInputArea({
  input,
  setInput,
  attachments,
  onSubmit,
  status,
  onStop,
  isGenerating,
  modeBorderClass,
  selectedModel,
  availableModels,
  model,
  setModel,
  thinkingEffort,
  cycleThinkingEffort,
  thinkingEffortOptions,
  modeOptions,
  currentMode,
  cycleMode,
  serviceTierOptions,
  currentServiceTier,
  toggleFastMode,
  goalSupported = false,
  goalArmed = false,
  onToggleGoal,
  slashCommands,
  modeButtonClass,
  supportsDynamicSwitch,
  canSteer = false,
  steerPending = false,
  onSteer,
  compactWhenIdle = false,
  mobileKeyboardOpen = false,
  hasPendingContext = false,
}: ChatInputAreaProps) {
  const intl = useIntl();
  const {
    mentionOverlayParts,
    mentionOverlayRef,
    textareaContainerRef,
    mention,
    handleMentionSelect,
    handleMentionKeyDown,
    handleTextareaChange,
    handleTextareaKeyUp,
    handleTextareaClick,
    handleTextareaSelect,
    handleTextareaScroll,
  } = useMentionOverlay({ input, setInput });

  const [cursorPos, setCursorPos] = useState(0);
  const [mobileActionExpanded, setMobileActionExpanded] = useState(false);
  const {
    slashCommand,
    selectedSkills,
    selectItem,
    removeSkill,
    clearSkills,
  } = useSlashCommand({ input, setInput, cursorPos, slashCommands });

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Skip all custom key handling during IME composition (e.g. Chinese input)
    if (e.nativeEvent.isComposing) return;

    // Backspace on empty input removes last skill chip
    if (e.key === 'Backspace' && !input && selectedSkills.length > 0) {
      e.preventDefault();
      removeSkill(selectedSkills[selectedSkills.length - 1].name);
      return;
    }

    // Slash command popup takes priority when open
    if (slashCommand.isOpen) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        slashCommand.moveUp();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        slashCommand.moveDown();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (slashCommand.suggestions.length > 0) {
          e.preventDefault();
          selectItem(slashCommand.suggestions[slashCommand.selectedIndex]);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        slashCommand.dismiss();
        return;
      }
    }
    handleMentionKeyDown(e);
  }, [slashCommand, selectItem, handleMentionKeyDown, input, selectedSkills, removeSkill]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setCursorPos(e.target.selectionStart ?? e.target.value.length);
    handleTextareaChange(e);
  }, [handleTextareaChange]);

  const handleKeyUp = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    setCursorPos(e.currentTarget.selectionStart ?? 0);
    handleTextareaKeyUp(e);
  }, [handleTextareaKeyUp]);

  const handleClick = useCallback((e: React.MouseEvent<HTMLTextAreaElement>) => {
    setCursorPos(e.currentTarget.selectionStart ?? 0);
    handleTextareaClick(e);
  }, [handleTextareaClick]);

  const handleSelect = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    setCursorPos(e.currentTarget.selectionStart ?? 0);
    handleTextareaSelect(e);
  }, [handleTextareaSelect]);

  const handleSubmitWithSkills = useCallback((message: PromptInputMessage) => {
    setMobileActionExpanded(false);
    if (selectedSkills.length > 0) {
      const skillPrefix = selectedSkills.map((s) => `[skill:${s.name}]`).join(' ');
      onSubmit({ ...message, text: `${skillPrefix} ${message.text}`.trim() });
      clearSkills();
    } else {
      onSubmit(message);
    }
  }, [selectedSkills, onSubmit, clearSkills]);

  const handleSteer = useCallback(async () => {
    if (!onSteer) return;
    const text = input.trim();
    if (!text) return;

    const prefixedText = selectedSkills.length > 0
      ? `${selectedSkills.map((s) => `[skill:${s.name}]`).join(' ')} ${text}`.trim()
      : text;

    setMobileActionExpanded(false);
    await onSteer(prefixedText);
    clearSkills();
  }, [clearSkills, input, onSteer, selectedSkills]);

  const handleComposerPointerDownCapture = useCallback((event: ReactPointerEvent<HTMLFormElement>) => {
    if (!compactWhenIdle) return;

    const target = event.target;
    if (!(target instanceof Element)) return;

    const textarea = textareaContainerRef.current?.querySelector('textarea');

    if (target.closest('[data-composer-dismiss-keyboard]')) {
      setMobileActionExpanded(false);
      textarea?.blur();
      return;
    }

    if (target.closest('[data-composer-submit]')) {
      setMobileActionExpanded(false);
      return;
    }

    // The file picker only opens from a genuine user activation, so this tap has
    // to reach the button as a native click. Keeping the keyboard is pointless
    // here anyway — the picker takes over the screen.
    if (target.closest('[data-composer-attach]')) return;

    // Let the textarea keep its native touch sequence. Expanding it during
    // pointerdown moves the target before iOS completes focus, so the first tap
    // only changes the layout and a second tap is needed to open the keyboard.
    if (target.closest('textarea')) return;

    if (target.closest('button, a, [role="button"]')) {
      // Keep the textarea focused so tapping an editing control does not dismiss
      // the phone keyboard. Submit/steer are excluded above and may still blur.
      event.preventDefault();
      setMobileActionExpanded(!mobileKeyboardOpen);
      if (textarea && document.activeElement !== textarea) {
        textarea.focus({ preventScroll: true });
      }
    }
  }, [compactWhenIdle, mobileKeyboardOpen, textareaContainerRef]);

  useEffect(() => {
    if (!compactWhenIdle) return;

    const composer = textareaContainerRef.current?.closest('form');
    if (!composer) return;

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;

      const target = event.target;
      if (!(target instanceof Element)) return;
      // data-composer-attach opts out of the synthetic-click path below: iOS
      // ignores input[type=file].click() unless it runs inside a transient user
      // activation, which touchstart does not provide.
      if (target.closest('[data-composer-submit], [data-composer-attach], textarea, input, select')) return;

      const action = target.closest('button, a, [role="button"]');
      if (!(action instanceof HTMLElement)) return;
      if (action.matches(':disabled, [aria-disabled="true"]')) return;

      if (target.closest('[data-composer-dismiss-keyboard]')) {
        event.preventDefault();
        setMobileActionExpanded(false);
        textareaContainerRef.current?.querySelector('textarea')?.blur();
        action.click();
        return;
      }

      // iOS may dismiss the software keyboard before React's pointer handler
      // can preserve focus. Cancel that native touch default with an active
      // listener, keep the textarea focused, then invoke the intended control.
      event.preventDefault();
      setMobileActionExpanded(!mobileKeyboardOpen);
      textareaContainerRef.current?.querySelector('textarea')?.focus({ preventScroll: true });
      action.click();
    };

    composer.addEventListener('touchstart', handleTouchStart, { capture: true, passive: false });
    return () => composer.removeEventListener('touchstart', handleTouchStart, true);
  }, [compactWhenIdle, mobileKeyboardOpen, textareaContainerRef]);

  useEffect(() => {
    if (mobileKeyboardOpen) setMobileActionExpanded(false);
  }, [mobileKeyboardOpen]);

  useEffect(() => {
    if (!compactWhenIdle || !mobileActionExpanded) return;

    const handleOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-slot="chat-composer"]')) return;
      setMobileActionExpanded(false);
    };

    document.addEventListener('pointerdown', handleOutsidePointerDown, true);
    return () => document.removeEventListener('pointerdown', handleOutsidePointerDown, true);
  }, [compactWhenIdle, mobileActionExpanded]);

  const fastOption = serviceTierOptions.find((option) => option.value === 'fast');
  const fastEnabled = currentServiceTier === 'fast';
  const thinkingLabel = thinkingEffortOptions.find((o) => o.value === thinkingEffort)?.label ?? thinkingEffort;
  const modeLabel = modeOptions.find((o) => o.value === currentMode)?.label ?? currentMode;
  const modeDescription = modeOptions.find((o) => o.value === currentMode)?.description;
  const steerLabel = steerPending
    ? intl.formatMessage({ id: 'editor.input.steering', defaultMessage: 'Steering...' })
    : intl.formatMessage({ id: 'editor.input.steer', defaultMessage: 'Steer' });
  const fullPlaceholder = intl.formatMessage({
    id: 'editor.input.placeholder',
    defaultMessage: 'Ask anything, @ to mention files, / to use commands...',
  });
  const compactPlaceholder = intl.formatMessage({
    id: 'editor.input.compactPlaceholder',
    defaultMessage: 'Ask anything...',
  });
  const hasDraft = hasComposerDraft({
    input,
    attachmentCount: attachments.files.length,
    selectedSkillCount: selectedSkills.length,
    hasPendingContext,
  });
  const composerCompact = compactWhenIdle && !mobileKeyboardOpen && !mobileActionExpanded && !hasDraft && !mention.isOpen && !slashCommand.isOpen;
  const compactStopVisible = composerCompact && isGenerating;
  const submitDisabled = availableModels.length === 0 || (!hasDraft && !isGenerating);
  const submitTitle = availableModels.length === 0
    ? intl.formatMessage({ id: 'editor.input.noModels', defaultMessage: 'No models available. Please configure a provider first.' })
    : undefined;

  return (
    <PromptInput
      data-slot="chat-composer"
      onSubmit={handleSubmitWithSkills}
      onPointerDownCapture={handleComposerPointerDownCapture}
      accept="image/*,application/pdf,.txt,.md,.csv,.json,.xml,.yaml,.yml,.html,.css,.js,.ts,.jsx,.tsx,.py,.java,.go,.rs,.c,.cpp,.h,.sh,.sql,.log,.env,.toml,.ini,.cfg"
      maxFileSize={10 * 1024 * 1024}
      multiple
      className={cn(
        'rounded-2xl bg-popover/90 overflow-hidden border border-border/60 transition-[border-color,box-shadow,background-color,min-height] duration-300 ease-out dark:border-border/35 dark:bg-popover/85',
        composerCompact
          ? 'shadow-none'
          : 'shadow-input',
        'focus-within:ring-1 focus-within:ring-tint/10 focus-within:border-tint/35 focus-within:bg-popover',
        '[&_[data-slot=input-group]]:border-none [&_[data-slot=input-group]]:shadow-none [&_[data-slot=input-group]]:bg-transparent [&_[data-slot=input-group]]:rounded-none',
        '[&_[data-slot=input-group]]:focus-within:ring-0 [&_[data-slot=input-group]]:focus-within:border-none',
        'cursor-text',
        modeBorderClass
      )}
      onClick={(e) => {
        const target = e.target as HTMLElement
        if (!target.closest('button, a, select, [role="button"], [role="combobox"], [data-slot="submit"]') && target.tagName !== 'TEXTAREA') {
          textareaContainerRef.current?.querySelector('textarea')?.focus()
        }
      }}
    >
      <PromptInputBody>
        {attachments.files.length > 0 && (
          <Attachments className="px-4 pt-4 ml-0 w-full" variant="grid">
            {attachments.files.map((file) => (
              <Attachment key={file.id} data={file} onRemove={() => attachments.remove(file.id)}>
                <AttachmentPreview />
                <AttachmentRemove />
              </Attachment>
            ))}
          </Attachments>
        )}
        <div
          ref={textareaContainerRef}
          className={cn(
            "flex w-full items-start gap-1.5 px-3 transition-[min-height,padding] duration-200 ease-out",
            compactStopVisible ? "flex-nowrap" : "flex-wrap",
            composerCompact ? "min-h-0 py-2" : "min-h-[60px] pt-2 pb-1.5"
          )}
        >
          <SkillChips skills={selectedSkills} onRemove={removeSkill} />
          <div className="relative min-w-0 flex-1">
            {mentionOverlayParts.length > 0 && (
              <div
                ref={mentionOverlayRef}
                aria-hidden
                className="pointer-events-none absolute inset-0 z-0 overflow-hidden text-base md:text-sm leading-6 whitespace-pre-wrap break-words"
              >
                {mentionOverlayParts.map((part, index) => (
                  <span
                    key={`${index}-${part.text.length}`}
                    className={part.isMention ? 'rounded-[4px] bg-muted/80 text-transparent [box-shadow:inset_0_0_0_1px_var(--color-border)]' : 'text-transparent'}
                  >
                    {part.text}
                  </span>
                ))}
              </div>
            )}
            <PromptInputTextarea
              data-testid="chat-input"
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onKeyUp={handleKeyUp}
              onClick={handleClick}
              onSelect={handleSelect}
              onScroll={handleTextareaScroll}
              value={input}
              placeholder={composerCompact ? compactPlaceholder : fullPlaceholder}
              className={cn(
                "relative z-10 self-stretch resize-none field-sizing-content bg-transparent p-0 text-base leading-6",
                composerCompact ? "max-h-6 min-h-6 overflow-hidden" : "min-h-[32px]"
              )}
            />
          </div>
          {compactStopVisible && (
            <PromptInputSubmit
              data-composer-submit
              data-testid="chat-submit"
              disabled={submitDisabled}
              title={submitTitle}
              status={status}
              onStop={() => void onStop()}
              className="size-9 shrink-0 rounded-lg"
            />
          )}
        </div>
        <MentionPopup
          isOpen={mention.isOpen}
          suggestions={mention.suggestions}
          selectedIndex={mention.selectedIndex}
          loading={mention.loading}
          anchorRef={textareaContainerRef}
          getDisplayPath={mention.getRelativePath}
          onSelect={handleMentionSelect}
          onHover={mention.setSelectedIndex}
        />
        <SlashCommandPopup
          isOpen={slashCommand.isOpen}
          suggestions={slashCommand.suggestions}
          selectedIndex={slashCommand.selectedIndex}
          loading={slashCommand.loading}
          anchorRef={textareaContainerRef}
          onSelect={selectItem}
          onHover={slashCommand.setSelectedIndex}
          onDismiss={slashCommand.dismiss}
        />
      </PromptInputBody>
      <PromptInputFooter
        className={cn(
          "@container gap-2 overflow-hidden px-3 transition-[max-height,opacity,padding] duration-200 ease-out",
          composerCompact ? "pointer-events-none max-h-0 pb-0 pt-0 opacity-0" : "max-h-16 pb-3 pt-1 opacity-100"
        )}
      >
        <PromptInputTools className="min-w-0 flex-1 overflow-hidden">
          <AttachmentButton />

          <ModelSelectorPanel
            selectedModel={selectedModel}
            availableModels={availableModels}
            model={model}
            setModel={setModel}
            buttonClassName={btnCn}
            disabled={isGenerating && !supportsDynamicSwitch}
          />

          {selectedModel?.hasThinking && thinkingEffortOptions.length > 0 && (
            <PromptInputButton
              data-testid="chat-thinking-toggle"
              onClick={cycleThinkingEffort}
              disabled={isGenerating}
              aria-label={`Thinking level: ${thinkingLabel}`}
              className={btnCn}
              title={`Thinking level: ${thinkingLabel}`}
            >
              <BrainIcon className="size-3.5" />
              <span>{thinkingLabel}</span>
            </PromptInputButton>
          )}

          {modeOptions.length > 0 && currentMode && (
            <PromptInputButton
              data-testid="chat-mode-toggle"
              onClick={cycleMode}
              disabled={isGenerating && !supportsDynamicSwitch}
              size="sm"
              className={cn(btnCn, modeButtonClass)}
              title={modeDescription}
            >
              <span className="max-w-20 truncate @max-[420px]:max-w-14">{modeLabel}</span>
            </PromptInputButton>
          )}

          {fastOption && (
            <PromptInputButton
              data-testid="chat-fast-toggle"
              onClick={toggleFastMode}
              disabled={isGenerating}
              size="sm"
              className={cn(
                btnCn,
                fastEnabled
                  ? 'border-amber-200 bg-amber-100/80 text-amber-700 hover:bg-amber-100 hover:text-amber-800'
                  : ''
              )}
              aria-label={intl.formatMessage({ id: 'editor.input.fast', defaultMessage: 'Fast' })}
              title={fastOption.description}
            >
              <Zap className="size-3.5" />
              <span className="@max-[440px]:sr-only"><FormattedMessage id="editor.input.fast" defaultMessage="Fast" /></span>
            </PromptInputButton>
          )}

          {goalSupported && (
            <PromptInputButton
              data-testid="chat-goal-toggle"
              type="button"
              onClick={onToggleGoal}
              disabled={isGenerating}
              aria-pressed={goalArmed}
              size="sm"
              className={cn(
                btnCn,
                goalArmed
                  ? 'border-tint/30 bg-tint/10 text-tint hover:bg-tint/15 hover:text-tint'
                  : ''
              )}
              title={intl.formatMessage({
                id: goalArmed ? 'editor.input.goalArmedHint' : 'editor.input.goalSetHint',
                defaultMessage: goalArmed
                  ? 'Goal mode on — your next message starts a goal. Click to turn off.'
                  : 'Turn on goal mode — your next message starts a goal the agent pursues.',
              })}
            >
              <Target className="size-3.5" />
              <span className="@max-[440px]:sr-only"><FormattedMessage id="editor.input.goal" defaultMessage="Goal" /></span>
            </PromptInputButton>
          )}

        </PromptInputTools>
        <div className="flex shrink-0 items-center gap-1.5">
          {canSteer && (
            <PromptInputButton
              data-composer-submit
              type="button"
              data-testid="chat-steer"
              variant="default"
              size="sm"
              disabled={steerPending || !input.trim()}
              onClick={() => void handleSteer()}
              className="h-9 shrink-0 rounded-lg px-2.5 @max-[440px]:size-9 @max-[440px]:p-0"
              title={intl.formatMessage({ id: 'editor.input.steerHint', defaultMessage: 'Send a follow-up while the model is responding' })}
              aria-label={steerLabel}
            >
              {steerPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <MessageSquarePlus className="size-4" />
              )}
              <span className="@max-[440px]:sr-only">
                {steerLabel}
              </span>
            </PromptInputButton>
          )}
          {!compactStopVisible && (
            <PromptInputSubmit
              data-composer-submit
              data-testid="chat-submit"
              disabled={submitDisabled}
              title={submitTitle}
              status={status}
              onStop={() => void onStop()}
              className="shrink-0 rounded-lg"
            />
          )}
        </div>
      </PromptInputFooter>
    </PromptInput>
  );
}
