import { useState } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { CheckIcon, XIcon } from 'lucide-react';
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationRejected,
  ConfirmationTitle,
} from '@/components/ai-elements/confirmation';
import type { ConfirmationProps } from '@/components/ai-elements/confirmation';
import { Tool, ToolHeader, ToolContent, ToolOutput } from '@/components/ai-elements/tool';
import type { ToolPart } from '@/components/ai-elements/tool';
import { normalizeToolState } from './toolState';
import { cn } from '@/lib/utils';
import type { ToolPartLike } from './toolName';

interface QuestionOption {
  label: string;
  description?: string;
}

interface Question {
  id?: string;
  question: string;
  header: string;
  /** Gemini question type: 'choice' (default), 'text', or 'yesno' */
  type?: 'choice' | 'text' | 'yesno';
  options?: QuestionOption[];
  multiSelect?: boolean;
  /** OpenCode uses "multiple" instead of "multiSelect" */
  multiple?: boolean;
  placeholder?: string;
}

/** Stable key for a question — prefer protocol id, fall back to question text */
function qKey(q: Question): string {
  return q.id ?? q.question;
}

interface AskUserQuestionInput {
  questions: Question[];
  answers?: Record<string, string>;
}

interface AskUserQuestionRendererProps {
  toolPart: ToolInvocationPart;
  messageId: string;
  partIndex: number;
  onPermissionDecide: (id: string, outcome: 'allow' | 'deny' | 'allowAlways', updatedInput?: Record<string, unknown>) => void;
}

export type ToolInvocationPart = ToolPartLike & {
  state?: string;
  result?: ToolPart['output'];
  output?: ToolPart['output'];
  errorText?: string;
  approval?: NonNullable<ConfirmationProps['approval']>;
  toolCallId?: string;
};

export function AskUserQuestionRenderer({
  toolPart,
  messageId,
  partIndex,
  onPermissionDecide,
}: AskUserQuestionRendererProps) {
  const intl = useIntl();
  const serverState = normalizeToolState(toolPart.state);
  const toolName = getToolDisplayName(toolPart);

  // Optimistic UI: track user's decision locally so the UI updates immediately
  const [optimisticOutcome, setOptimisticOutcome] = useState<'allow' | 'deny' | null>(null);
  const state = optimisticOutcome && serverState === 'approval-requested'
    ? 'approval-responded'
    : serverState;
  const isGemini = toolName === 'ask_user';
  const rawInput = (toolPart.args || toolPart.input || {}) as unknown as AskUserQuestionInput;
  const rawQuestions = rawInput.questions ?? [];
  // Normalize: unify "multiple" → "multiSelect", ensure options exist for yesno type
  const questions = rawQuestions.map((q) => {
    const normalized = { ...q, multiSelect: q.multiSelect ?? q.multiple ?? false };
    if (normalized.type === 'yesno' && (!normalized.options || normalized.options.length === 0)) {
      return {
        ...normalized,
        options: [
          { label: intl.formatMessage({ id: 'editor.ask.yes', defaultMessage: 'Yes' }) },
          { label: intl.formatMessage({ id: 'editor.ask.no', defaultMessage: 'No' }) },
        ],
      };
    }
    return normalized;
  });
  const output = toolPart.result ?? toolPart.output;
  const hasOutput = output !== undefined && output !== null;

  // State for answers
  const [answers, setAnswers] = useState<Record<string, string[]>>(() => {
    const initial: Record<string, string[]> = {};
    questions.forEach((q) => {
      initial[qKey(q)] = [];
    });
    return initial;
  });

  // State for custom "Other" text inputs
  const [otherTexts, setOtherTexts] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    questions.forEach((q) => {
      initial[qKey(q)] = '';
    });
    return initial;
  });

  // State for showing custom input for each question
  const [showOther, setShowOther] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    questions.forEach((q) => {
      initial[qKey(q)] = false;
    });
    return initial;
  });

  const approvalId = toolPart.approval?.id ?? toolPart.toolCallId;
  const baseApproval: ConfirmationProps['approval'] =
    toolPart.approval ?? (approvalId ? { id: approvalId } : undefined);
  const approval = optimisticOutcome && baseApproval
    ? { ...baseApproval, approved: optimisticOutcome !== 'deny' }
    : baseApproval;

  const shouldExpand = state === 'approval-requested';

  const handleOptionSelect = (key: string, optionLabel: string, multiSelect: boolean) => {
    setAnswers((prev) => {
      const current = prev[key] ?? [];
      if (multiSelect) {
        if (current.includes(optionLabel)) {
          return { ...prev, [key]: current.filter((l) => l !== optionLabel) };
        }
        return { ...prev, [key]: [...current, optionLabel] };
      }
      return { ...prev, [key]: [optionLabel] };
    });
    // Single-select: picking a normal option always deselects "Other"
    if (!multiSelect) {
      setShowOther((prev) => ({ ...prev, [key]: false }));
    }
  };

  const handleOtherToggle = (key: string, multiSelect: boolean) => {
    const willShowOther = !showOther[key];
    setShowOther((prev) => ({ ...prev, [key]: willShowOther }));
    // Single-select: picking "Other" clears normal options
    if (!multiSelect && willShowOther) {
      setAnswers((prev) => ({ ...prev, [key]: [] }));
    }
  };

  const handleOtherTextChange = (key: string, text: string) => {
    setOtherTexts((prev) => ({ ...prev, [key]: text }));
  };

  const handleSubmit = () => {
    if (!approvalId) return;

    // Build answers object
    const formattedAnswers: Record<string, string> = {};
    questions.forEach((q, index) => {
      const k = qKey(q);
      const selectedOptions = answers[k] ?? [];
      const otherText = otherTexts[k]?.trim() ?? '';
      const useOther = showOther[k] && otherText;
      // Gemini uses numeric indices as keys; Codex/CC uses question id or text
      const key = isGemini ? String(index) : k;

      // Text-only questions always use the text field
      if (q.type === 'text' && (!q.options || q.options.length === 0)) {
        if (otherText) formattedAnswers[key] = otherText;
      } else if (useOther) {
        formattedAnswers[key] = otherText;
      } else if (selectedOptions.length > 0) {
        formattedAnswers[key] = selectedOptions.join(', ');
      }
    });

    setOptimisticOutcome('allow');

    if (isGemini) {
      // Gemini payload: only answers (ToolAskUserConfirmationPayload)
      onPermissionDecide(approvalId, 'allow', { answers: formattedAnswers });
    } else {
      // CC payload: questions + answers keyed by question text
      onPermissionDecide(approvalId, 'allow', {
        questions: rawInput.questions,
        answers: formattedAnswers,
      } as Record<string, unknown>);
    }
  };

  const handleDeny = () => {
    if (!approvalId) return;
    setOptimisticOutcome('deny');
    onPermissionDecide(approvalId, 'deny');
  };

  // Check if all questions have answers
  const isComplete = questions.every((q) => {
    const k = qKey(q);
    const selectedOptions = answers[k] ?? [];
    const otherText = otherTexts[k]?.trim() ?? '';
    const useOther = showOther[k] && otherText;
    if (q.type === 'text' && (!q.options || q.options.length === 0)) {
      return otherText.length > 0;
    }
    return selectedOptions.length > 0 || useOther;
  });

  return (
    <Tool key={`${messageId}-${partIndex}`} {...(shouldExpand ? { open: true } : {})}>
      <ToolHeader type="dynamic-tool" toolName={intl.formatMessage({ id: 'editor.ask.toolName', defaultMessage: 'Ask User' })} state={state} />
      <ToolContent>
        {state === 'approval-requested' ? (
          <div className="space-y-4 p-4">
            {questions.map((question, qIndex) => (
              <div key={qIndex} className="space-y-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium px-2 py-0.5 rounded-md bg-muted/60 text-muted-foreground">
                    {question.header}
                  </span>
                </div>
                <p className="text-sm font-medium">{question.question}</p>
                <div className="space-y-1.5">
                  {/* Text-only question (Gemini type='text') — no options, just input */}
                  {question.type === 'text' && (!question.options || question.options.length === 0) ? (
                    <input
                      type="text"
                      value={otherTexts[qKey(question)] ?? ''}
                      onChange={(e) => {
                        handleOtherTextChange(qKey(question), e.target.value);
                        setShowOther((prev) => ({ ...prev, [qKey(question)]: true }));
                      }}
                      placeholder={question.placeholder ?? intl.formatMessage({ id: 'editor.ask.answerPlaceholder', defaultMessage: 'Enter your answer...' })}
                      className="w-full px-3 py-2 text-sm rounded-lg bg-muted/40 focus:outline-none focus:ring-1 focus:ring-primary/40 placeholder:text-muted-foreground/50"
                      autoFocus
                    />
                  ) : (
                  <>
                  {(question.options ?? []).map((option, oIndex) => {
                    const isSelected = (answers[qKey(question)] ?? []).includes(option.label);
                    return (
                      <button
                        type="button"
                        key={oIndex}
                        onClick={() => handleOptionSelect(qKey(question), option.label, question.multiSelect ?? false)}
                        className={cn(
                          'w-full text-left px-3 py-2.5 rounded-lg transition-all',
                          isSelected
                            ? 'bg-tint-muted ring-1 ring-tint/40'
                            : 'hover:bg-muted/50'
                        )}
                      >
                        <div className="flex items-start gap-2.5">
                          <div
                            className={cn(
                              'mt-0.5 size-4 rounded flex items-center justify-center shrink-0 transition-colors',
                              question.multiSelect ? 'rounded' : 'rounded-full',
                              isSelected
                                ? 'bg-tint text-tint-fg'
                                : 'ring-1 ring-border'
                            )}
                          >
                            {isSelected && <CheckIcon className="size-3" />}
                          </div>
                          <div>
                            <p className="text-sm font-medium">{option.label}</p>
                            {option.description && (
                              <p className="text-xs text-muted-foreground mt-0.5">{option.description}</p>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}

                  {/* Other option */}
                  <button
                    type="button"
                    onClick={() => handleOtherToggle(qKey(question), question.multiSelect ?? false)}
                    className={cn(
                      'w-full text-left px-3 py-2.5 rounded-lg transition-all',
                      showOther[qKey(question)]
                        ? 'bg-tint-muted ring-1 ring-tint/40'
                        : 'hover:bg-muted/50'
                    )}
                  >
                    <div className="flex items-start gap-2.5">
                      <div
                        className={cn(
                          'mt-0.5 size-4 rounded flex items-center justify-center shrink-0 transition-colors',
                          question.multiSelect ? 'rounded' : 'rounded-full',
                          showOther[qKey(question)]
                            ? 'bg-tint text-tint-fg'
                            : 'ring-1 ring-border'
                        )}
                      >
                        {showOther[qKey(question)] && <CheckIcon className="size-3" />}
                      </div>
                      <p className="text-sm font-medium"><FormattedMessage id="editor.ask.other" defaultMessage="Other" /></p>
                    </div>
                  </button>

                  {/* Custom text input */}
                  {showOther[qKey(question)] && (
                    <input
                      type="text"
                      value={otherTexts[qKey(question)] ?? ''}
                      onChange={(e) => handleOtherTextChange(qKey(question), e.target.value)}
                      placeholder={question.placeholder ?? intl.formatMessage({ id: 'editor.ask.answerPlaceholder', defaultMessage: 'Enter your answer...' })}
                      className="w-full px-3 py-2 text-sm rounded-lg bg-muted/40 focus:outline-none focus:ring-1 focus:ring-primary/40 placeholder:text-muted-foreground/50"
                      autoFocus
                    />
                  )}
                  </>
                  )}
                </div>
              </div>
            ))}

            <div className="flex gap-2 pt-2" data-testid="ask-user-question">
              <button
                type="button"
                data-testid="ask-user-question-cancel"
                onClick={handleDeny}
                className="px-4 py-2 text-sm rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
              >
                <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
              </button>
              <button
                type="button"
                data-testid="ask-user-question-submit"
                onClick={handleSubmit}
                disabled={!isComplete}
                className={cn(
                  'px-4 py-2 text-sm rounded-lg transition-colors',
                  isComplete
                    ? 'bg-tint text-tint-fg hover:bg-tint-soft'
                    : 'bg-muted text-muted-foreground cursor-not-allowed'
                )}
              >
                <FormattedMessage id="editor.ask.submit" defaultMessage="Submit" />
              </button>
            </div>
          </div>
        ) : state === 'input-streaming' ? (
          // Data is still streaming, show loading
          <div className="p-4 text-sm text-muted-foreground"><FormattedMessage id="editor.ask.loading" defaultMessage="Loading questions..." /></div>
        ) : (
          // Display questions in a readable format for input-available and other states
          <div className="space-y-3 p-4">
            {questions.map((question, qIndex) => (
              <div key={qIndex} className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium px-2 py-0.5 rounded-md bg-muted/60 text-muted-foreground">
                    {question.header}
                  </span>
                </div>
                <p className="text-sm font-medium">{question.question}</p>
                <div className="space-y-1">
                  {(question.options ?? []).map((option, oIndex) => (
                    <div
                      key={oIndex}
                      className="flex items-start gap-2.5 px-3 py-2 rounded-lg"
                    >
                      <div
                        className={cn(
                          'mt-0.5 size-4 rounded flex items-center justify-center shrink-0 ring-1 ring-border/60',
                          question.multiSelect ? 'rounded' : 'rounded-full'
                        )}
                      />
                      <div>
                        <p className="text-sm">{option.label}</p>
                        {option.description && (
                          <p className="text-xs text-muted-foreground">{option.description}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {rawInput.answers && Object.keys(rawInput.answers).length > 0 && (
              <div className="pt-2 border-t border-border/60">
                <p className="text-xs font-medium text-muted-foreground mb-2"><FormattedMessage id="editor.ask.answersProvided" defaultMessage="Answers provided:" /></p>
                {Object.entries(rawInput.answers).map(([q, a]) => (
                  <div key={q} className="text-sm">
                    <span className="text-muted-foreground">{q}: </span>
                    <span className="font-medium">{a}</span>
                  </div>
                ))}
              </div>
            )}
            <Confirmation approval={approval} state={state}>
              <ConfirmationTitle>
                <ConfirmationAccepted>
                  <CheckIcon className="size-4 text-green-600 dark:text-green-400" />
                  <span><FormattedMessage id="editor.ask.answered" defaultMessage="Answered" /></span>
                </ConfirmationAccepted>
                <ConfirmationRejected>
                  <XIcon className="size-4 text-destructive" />
                  <span><FormattedMessage id="editor.ask.cancelled" defaultMessage="Cancelled" /></span>
                </ConfirmationRejected>
              </ConfirmationTitle>
            </Confirmation>
          </div>
        )}
        {(hasOutput || toolPart.errorText) ? <ToolOutput output={output} errorText={toolPart.errorText} /> : null}
      </ToolContent>
    </Tool>
  );
}

import { getToolDisplayName } from './toolName';

/**
 * Check if a tool part is an AskUserQuestion tool
 * Supports both Claude Code (AskUserQuestion) and Gemini (ask_user)
 */
export function isAskUserQuestionTool(toolPart: ToolPartLike): boolean {
  const toolName = getToolDisplayName(toolPart);
  return toolName === 'AskUserQuestion' || toolName === 'ask_user';
}
