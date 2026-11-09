import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { textPartQuestion } from './textPartQuestion';

type Part = UIMessage['parts'][number];

const text = (value: string, runtime?: Record<string, unknown>): Part => ({
  type: 'text',
  text: value,
  ...(runtime ? { providerMetadata: { runtime } as NonNullable<Extract<Part, { type: 'text' }>['providerMetadata']> } : {}),
});
const one = [{ title: 'Which?', options: ['A', 'B'] }];
const several = [{ title: 'Which?', options: ['A'] }, { title: 'Why?', options: [] }];
const asked = text('Which?\n- A\n- B', { phase: 'final_answer', questions: one });
const closing = text('Pick one and I will start.', { phase: 'final_answer' });
const progress = text('Reading the code.', { phase: 'commentary' });

describe('textPartQuestion', () => {
  it('moves the form onto the closing answer and hides the question', () => {
    const parts = [progress, asked, closing];
    expect(textPartQuestion(parts, 0)).toBeUndefined();
    expect(textPartQuestion(parts, 1)).toEqual({ hidden: true });
    expect(textPartQuestion(parts, 2)).toEqual({ hidden: false, text: 'Pick one and I will start.', questions: one });
  });

  it('shows the title and form while no closing answer has come', () => {
    expect(textPartQuestion([asked, progress], 0)).toEqual({ hidden: false, text: 'Which?', questions: one });
    expect(textPartQuestion([asked, progress], 1)).toBeUndefined();
  });

  it('shows no text of its own for several questions', () => {
    const part = text('Which?\nWhy?', { phase: 'final_answer', questions: several });
    expect(textPartQuestion([part], 0)).toEqual({ hidden: false, text: '', questions: several });
  });

  it('leaves replies without a question alone', () => {
    expect(textPartQuestion([text('Hello')], 0)).toBeUndefined();
    expect(textPartQuestion([closing], 0)).toBeUndefined();
  });

  it('gives each question only its own closing answer', () => {
    const parts = [asked, closing, closing];
    expect(textPartQuestion(parts, 1)).toMatchObject({ questions: one });
    expect(textPartQuestion(parts, 2)).toBeUndefined();
  });
});
