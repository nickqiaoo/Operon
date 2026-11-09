import type { UIMessage } from 'ai';
import type { Question } from '@/components/ai-elements/question-form';

type Part = UIMessage['parts'][number];

export type TextPartQuestion =
  /** The turn's closing answer restates these questions, and carries the form instead. */
  | { hidden: true }
  /** `text` is what shows above the form: empty when the form says it all. */
  | { hidden: false; text: string; questions: Question[] };

function runtimeOf(part: Part): { phase?: unknown; questions?: Question[] } | undefined {
  if (part.type !== 'text') return undefined;
  return part.providerMetadata?.runtime as { phase?: unknown; questions?: Question[] } | undefined;
}

const isFinal = (part: Part) => runtimeOf(part)?.phase === 'final_answer' && !runtimeOf(part)?.questions;

/**
 * How a text part shows questions the agent asked. Their own text is a plain-text rendering with
 * the options listed, and the turn still closes with an answer that restates them, so when one
 * follows, that answer is what shows, with the form under it.
 */
export function textPartQuestion(parts: readonly Part[], index: number): TextPartQuestion | undefined {
  const own = runtimeOf(parts[index])?.questions;
  if (own) {
    for (const part of parts.slice(index + 1)) {
      if (runtimeOf(part)?.questions) break;
      if (isFinal(part)) return { hidden: true };
    }
    return { hidden: false, text: own.length === 1 ? own[0].title : '', questions: own };
  }
  if (!isFinal(parts[index])) return undefined;
  for (let i = index - 1; i >= 0; i--) {
    const asked = runtimeOf(parts[i])?.questions;
    if (asked) return { hidden: false, text: (parts[index] as { text: string }).text, questions: asked };
    if (isFinal(parts[i])) return undefined;
  }
  return undefined;
}
