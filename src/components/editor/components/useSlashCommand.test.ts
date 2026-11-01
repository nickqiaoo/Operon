import { describe, expect, it } from 'vitest';
import { formatSlashCommandPrefix } from './useSlashCommand';

describe('inline slash token submission', () => {
  it('keeps skill references and command syntax distinct in selection order', () => {
    expect(formatSlashCommandPrefix([
      { name: 'review', type: 'command', description: '' },
      { name: 'longbridge-content', type: 'skill', description: '' },
    ])).toBe('/review [skill:longbridge-content]');
  });

  it('sends a selected command as a command rather than a skill reference', () => {
    expect(formatSlashCommandPrefix([
      { name: 'compact', type: 'command', description: '' },
    ])).toBe('/compact');
  });

  it('adds no prefix when all tokens have been removed', () => {
    expect(formatSlashCommandPrefix([])).toBe('');
  });
});
