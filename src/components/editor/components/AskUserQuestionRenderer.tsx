import { useState, type FormEvent } from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import { MessageCircleQuestionIcon } from 'lucide-react';
import type { ConfirmationProps } from '@/components/ai-elements/confirmation';
import { Tool, ToolContent, ToolLine, ToolOutput, toolTraceStatus } from '@/components/ai-elements/tool';
import type { ToolPart } from '@/components/ai-elements/tool';
import { Button } from '@/components/ui/button';
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from '@/components/ui/questionnaire';
import { TraceCollapsibleTrigger, TraceDescription } from '@/components/ui/trace';
import { normalizeToolState } from './toolState';
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

/**
 * AskUserQuestion (Claude Code) / ask_user (Gemini) / OpenCode's question tool.
 *
 * While it waits, the questions are a shadcn Questionnaire — one at a time, each
 * with its options plus a free-text answer — sitting under the tool line the way
 * an approval does: a question for the person, not a step. Once answered (or
 * cancelled) it is just the line, which opens onto what was asked and answered.
 */
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
  const approvalId = toolPart.approval?.id ?? toolPart.toolCallId;
  const awaiting = state === 'approval-requested';
  const answered = optimisticOutcome === 'allow' || toolPart.approval?.approved === true;
  const cancelled = optimisticOutcome === 'deny' || toolPart.approval?.approved === false;

  // Questionnaire items are form fields; their names are positional so any
  // question text (quotes, newlines) is safe as a key.
  const fieldName = (index: number) => `q${index}`;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!approvalId) return;
    const form = new FormData(event.currentTarget);

    const formattedAnswers: Record<string, string> = {};
    questions.forEach((q, index) => {
      const values = form.getAll(fieldName(index))
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean);
      // Gemini uses numeric indices as keys; Codex/CC uses question id or text
      const key = isGemini ? String(index) : qKey(q);
      if (values.length > 0) formattedAnswers[key] = values.join(', ');
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

  const answerPlaceholder = intl.formatMessage({ id: 'editor.ask.answerPlaceholder', defaultMessage: 'Enter your answer...' });
  const otherPlaceholder = intl.formatMessage({ id: 'editor.ask.otherPlaceholder', defaultMessage: 'Something else…' });

  return (
    <div key={`${messageId}-${partIndex}`} className="flex min-w-0 flex-col gap-2">
      <Tool>
        <TraceCollapsibleTrigger>
          <ToolLine
            icon={<MessageCircleQuestionIcon />}
            name={intl.formatMessage({ id: 'editor.ask.toolName', defaultMessage: 'Ask User' })}
            status={awaiting ? undefined : toolTraceStatus(state)}
            trailing={
              awaiting ? null : answered ? (
                <TraceDescription><FormattedMessage id="editor.ask.answered" defaultMessage="Answered" /></TraceDescription>
              ) : cancelled ? (
                <TraceDescription><FormattedMessage id="editor.ask.cancelled" defaultMessage="Cancelled" /></TraceDescription>
              ) : null
            }
          />
        </TraceCollapsibleTrigger>
        <ToolContent>
          {state === 'input-streaming' ? (
            <p className="text-sm"><FormattedMessage id="editor.ask.loading" defaultMessage="Loading questions..." /></p>
          ) : (
            <dl className="space-y-2 text-sm">
              {questions.map((question, qIndex) => {
                const answer = rawInput.answers?.[qKey(question)] ?? rawInput.answers?.[String(qIndex)];
                return (
                  <div key={qIndex} className="space-y-0.5">
                    <dt>{question.question}</dt>
                    {answer ? <dd className="text-foreground">{answer}</dd> : null}
                  </div>
                );
              })}
            </dl>
          )}
          {(hasOutput || toolPart.errorText) ? <ToolOutput output={output} errorText={toolPart.errorText} /> : null}
        </ToolContent>
      </Tool>

      {awaiting && questions.length > 0 && (
        <Questionnaire
          data-testid="ask-user-question"
          onSubmit={handleSubmit}
          className="not-prose gap-4 rounded-xl border border-border/60 bg-background p-4 dark:border-border/35"
        >
          {questions.length > 1 && <QuestionnaireProgress />}
          {questions.map((question, qIndex) => {
            const textOnly = question.type === 'text' && (!question.options || question.options.length === 0);
            return (
              <QuestionnaireItem
                key={qIndex}
                name={fieldName(qIndex)}
                multiple={question.multiSelect}
                required
                className="gap-3"
              >
                <QuestionnaireTitle className="text-sm [&:not(:has(~[data-slot=questionnaire-description]))]:mb-3">
                  {question.question}
                </QuestionnaireTitle>
                {question.header && question.header !== question.question && (
                  <QuestionnaireDescription className="text-xs">{question.header}</QuestionnaireDescription>
                )}
                <QuestionnaireChoices className="gap-2">
                  {!textOnly && (question.options ?? []).map((option, oIndex) => (
                    <QuestionnaireChoice key={oIndex} value={option.label} className="min-h-0 px-3 py-2.5">
                      <span className="font-medium">{option.label}</span>
                      {option.description && (
                        <QuestionnaireChoiceDescription className="text-xs">{option.description}</QuestionnaireChoiceDescription>
                      )}
                    </QuestionnaireChoice>
                  ))}
                  <QuestionnaireInput
                    aria-label={textOnly ? question.question : otherPlaceholder}
                    placeholder={question.placeholder ?? (textOnly ? answerPlaceholder : otherPlaceholder)}
                    className="h-9 min-h-0 text-sm"
                  />
                </QuestionnaireChoices>
                <QuestionnaireError className="mt-0 text-xs" />
              </QuestionnaireItem>
            );
          })}
          <div className="flex items-center gap-2">
            <Button
              type="button"
              data-testid="ask-user-question-cancel"
              size="sm"
              variant="ghost"
              className="h-8"
              onClick={handleDeny}
            >
              <FormattedMessage id="common.cancel" defaultMessage="Cancel" />
            </Button>
            <QuestionnaireActions className="ml-auto flex w-auto min-h-0 justify-end gap-2 sm:min-h-0">
              <QuestionnairePrevious>
                <FormattedMessage id="editor.ask.previous" defaultMessage="Previous" />
              </QuestionnairePrevious>
              <QuestionnaireNext>
                <FormattedMessage id="editor.ask.next" defaultMessage="Next" />
              </QuestionnaireNext>
              <QuestionnaireSubmit data-testid="ask-user-question-submit">
                <FormattedMessage id="editor.ask.submit" defaultMessage="Submit" />
              </QuestionnaireSubmit>
            </QuestionnaireActions>
          </div>
        </Questionnaire>
      )}
    </div>
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
