import type { UIMessage } from 'ai';
import type { Question } from '@/components/ai-elements/question-form';
import { getInjectedInput } from './steer-message';

type Part = UIMessage['parts'][number];

export type TextPartQuestion =
  /** The turn's closing answer restates these questions, and carries the form instead. */
  | { hidden: true }
  /** `text` is what shows above the form: empty when the form says it all. */
  | { hidden: false; text: string; questions: Question[]; sourceIndex: number };

function runtimeOf(part: Part): { phase?: unknown; questions?: Question[] } | undefined {
  if (part.type !== 'text') return undefined;
  return part.providerMetadata?.runtime as { phase?: unknown; questions?: Question[] } | undefined;
}

const isFinal = (part: Part) => runtimeOf(part)?.phase === 'final_answer' && !runtimeOf(part)?.questions;

/**
 * How a text part shows questions the agent asked. Their own text is a plain-text rendering with
 * the options listed. An unanswered form can move to the closing answer that restates it;
 * a question already answered mid-turn stays where it was asked.
 */
export function textPartQuestion(parts: readonly Part[], index: number): TextPartQuestion | undefined {
  const own = runtimeOf(parts[index])?.questions;
  if (own) {
    for (const part of parts.slice(index + 1)) {
      if (getInjectedInput(part)) break;
      if (runtimeOf(part)?.questions) break;
      if (isFinal(part)) return { hidden: true };
    }
    return { hidden: false, text: own.length === 1 ? own[0].title : '', questions: own, sourceIndex: index };
  }
  if (!isFinal(parts[index])) return undefined;
  for (let i = index - 1; i >= 0; i--) {
    if (getInjectedInput(parts[i])) break;
    const asked = runtimeOf(parts[i])?.questions;
    if (asked) return { hidden: false, text: (parts[index] as { text: string }).text, questions: asked, sourceIndex: i };
    if (isFinal(parts[i])) return undefined;
  }
  return undefined;
}

/** A follow-up read after this question, before another question was asked. */
export function textPartQuestionAnswer(parts: readonly Part[], sourceIndex: number): string | undefined {
  for (const part of parts.slice(sourceIndex + 1)) {
    if (runtimeOf(part)?.questions) break;
    const injected = getInjectedInput(part);
    if (injected) return injected.text;
  }
  return undefined;
}
