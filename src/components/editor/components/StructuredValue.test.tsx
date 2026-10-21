import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { StructuredOrText, StructuredValue } from './StructuredValue';

function render(node: React.ReactNode) {
  return renderToStaticMarkup(<IntlProvider locale="en">{node}</IntlProvider>);
}

describe('StructuredValue', () => {
  it('draws a review as fields, cards and verdict chips instead of JSON', () => {
    const html = render(
      <StructuredValue
        value={{
          verdict: 'changes',
          issues: [{ severity: 'critical', where: 'src/a.ts:12', issue: 'Off by one' }],
          rulings: [],
          designBroken: '',
        }}
      />,
    );
    expect(html).not.toContain('{');
    expect(html).toContain('verdict');
    expect(html).toContain('text-status-error');
    expect(html).toContain('Off by one');
    expect(html).toContain('none');
    // An empty text field is left out rather than shown blank.
    expect(html).not.toContain('design broken');
  });

  it('keeps the narration before a reply and leaves plain prose as text', () => {
    const structured = render(
      <StructuredOrText text={'Checked it. {"ok":true}'} fallback={(t) => <p>{t}</p>} />,
    );
    expect(structured).toContain('<p>Checked it.</p>');
    expect(structured).toContain('ok');

    const prose = render(<StructuredOrText text="Use {a} here." fallback={(t) => <p>{t}</p>} />);
    expect(prose).toBe('<p>Use {a} here.</p>');
  });
});
