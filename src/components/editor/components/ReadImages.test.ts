import { describe, expect, it } from 'vitest';
import { toolImagesOf, uniqueToolImages } from './ReadImages';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function mcpScreenshot(state = 'output-available') {
  return {
    type: 'tool-mcp__electron-devtools__take_screenshot',
    toolName: 'mcp__electron-devtools__take_screenshot',
    toolCallId: 'shot-1',
    state,
    input: {},
    output: { content: [{ type: 'text', text: 'Took a screenshot.' }, { type: 'image', data: PNG, mimeType: 'image/png' }] },
  };
}

describe('toolImagesOf', () => {
  it('takes the image an MCP tool returned inline', () => {
    const images = toolImagesOf(mcpScreenshot());
    expect(images).toHaveLength(1);
    expect(images[0].src).toBe(`data:image/png;base64,${PNG}`);
  });

  it('takes the file a Read of an image looked at, by path', () => {
    const read = { type: 'tool-Read', toolName: 'Read', toolCallId: 'r1', state: 'output-available', input: { file_path: '/tmp/a.png' }, output: '[image]' };
    expect(toolImagesOf(read)).toEqual([{ key: 'path:/tmp/a.png', path: '/tmp/a.png' }]);
  });

  it('has nothing for a call that has not finished, or returned only text', () => {
    expect(toolImagesOf(mcpScreenshot('input-available'))).toEqual([]);
    const bash = { type: 'tool-Bash', toolName: 'Bash', toolCallId: 'b1', state: 'output-available', input: { command: 'ls' }, output: 'a\nb' };
    expect(toolImagesOf(bash)).toEqual([]);
  });

  it('lists a picture returned twice only once', () => {
    expect(uniqueToolImages([mcpScreenshot(), { ...mcpScreenshot(), toolCallId: 'shot-2' }])).toHaveLength(1);
  });
});
