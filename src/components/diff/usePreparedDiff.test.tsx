// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PreparedDiff } from './prepare-diff';

const workers = vi.hoisted(() => ({ instances: [] as Array<{
  onmessage: ((event: { data: { id: number; result: PreparedDiff } }) => void) | null;
  onerror: (() => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}> }));
vi.mock('./prepare-diff.worker?worker', () => ({ default: class {
  onmessage = null;
  onerror = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { workers.instances.push(this); }
} }));
import { usePreparedDiff } from './usePreparedDiff';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
function Preview({ text }: { text: string }) {
  const result = usePreparedDiff('test.txt', '', text);
  return <span>{result?.status ?? 'loading'}</span>;
}
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  act(() => vi.advanceTimersByTime(5_000));
  vi.useRealTimers();
});

it('coalesces streaming updates and deduplicates title/preview requests', async () => {
  act(() => root.render(<><Preview text="first" /><Preview text="first" /></>));
  act(() => root.render(<><Preview text="latest" /><Preview text="latest" /></>));
  act(() => vi.advanceTimersByTime(150));
  const worker = workers.instances.at(-1)!;
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  expect(worker.postMessage.mock.calls[0][0].input.newContent).toBe('latest');
  const { id } = worker.postMessage.mock.calls[0][0];
  await act(async () => worker.onmessage?.({ data: { id, result: { status: 'limited' } } }));
  expect(host.textContent).toBe('limitedlimited');
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it('ignores stale results after the input changes', async () => {
  act(() => root.render(<Preview text="old input" />));
  act(() => vi.advanceTimersByTime(150));
  const worker = workers.instances.at(-1)!;
  const { id } = worker.postMessage.mock.calls[0][0];
  act(() => root.render(<Preview text="new input" />));
  await act(async () => worker.onmessage?.({ data: { id, result: { status: 'limited' } } }));
  expect(host.textContent).toBe('loading');
});

it('terminates a stuck worker and resolves to a limited preview', async () => {
  act(() => root.render(<Preview text="timeout input" />));
  act(() => vi.advanceTimersByTime(150));
  const worker = workers.instances.at(-1)!;
  await act(async () => vi.advanceTimersByTime(5_000));
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(host.textContent).toBe('limited');
});

it('does not start work after a preview is closed before the debounce', () => {
  const before = workers.instances.length;
  act(() => root.render(<Preview text="closed input" />));
  act(() => root.render(null));
  act(() => vi.advanceTimersByTime(150));
  expect(workers.instances.length).toBe(before);
});

it('reuses the prepared result when the preview is reopened', async () => {
  act(() => root.render(<Preview text="cached input" />));
  act(() => vi.advanceTimersByTime(150));
  const worker = workers.instances.at(-1)!;
  const { id } = worker.postMessage.mock.calls[0][0];
  await act(async () => worker.onmessage?.({ data: { id, result: { status: 'limited' } } }));
  const count = workers.instances.length;
  act(() => root.render(null));
  act(() => root.render(<Preview text="cached input" />));
  await act(async () => vi.advanceTimersByTime(150));
  expect(host.textContent).toBe('limited');
  expect(workers.instances.length).toBe(count);
});

it('falls back without running the comparison on the UI thread when a worker fails', async () => {
  act(() => root.render(<Preview text="worker failure" />));
  act(() => vi.advanceTimersByTime(150));
  const worker = workers.instances.at(-1)!;
  await act(async () => worker.onerror?.());
  expect(host.textContent).toBe('limited');
  expect(worker.terminate).toHaveBeenCalledOnce();
});
