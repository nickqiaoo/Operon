import { useEffect, useState } from 'react';
import DiffWorker from './prepare-diff.worker?worker';
import type { DiffInput, PreparedDiff } from './prepare-diff';

interface Job extends DiffInput {
  id: number;
  promise: Promise<PreparedDiff>;
  resolve: (result: PreparedDiff) => void;
  timer: ReturnType<typeof setTimeout>;
}
let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, Job>();
const cache: Array<DiffInput & { result: PreparedDiff }> = [];
const matches = (a: DiffInput, b: DiffInput) =>
  a.filePath === b.filePath && a.oldContent === b.oldContent && a.newContent === b.newContent;

function stopWorker() {
  worker?.terminate();
  worker = undefined;
  for (const job of pending.values()) {
    clearTimeout(job.timer);
    job.resolve({ status: 'limited' });
  }
  pending.clear();
}

function requestDiff(input: DiffInput): Promise<PreparedDiff> {
  const cached = cache.find((entry) => matches(entry, input));
  if (cached) return Promise.resolve(cached.result);
  const existing = [...pending.values()].find((entry) => matches(entry, input));
  if (existing) return existing.promise;
  try {
    if (!worker) {
      worker = new DiffWorker();
      worker.onerror = stopWorker;
      worker.onmessage = ({ data }: MessageEvent<{ id: number; result: PreparedDiff }>) => {
        const job = pending.get(data.id);
        if (!job) return;
        clearTimeout(job.timer);
        pending.delete(data.id);
        // Keep at most eight results and eight MiB of source text across previews.
        cache.unshift({ filePath: job.filePath, oldContent: job.oldContent, newContent: job.newContent, result: data.result });
        let chars = 0;
        const excess = cache.findIndex((entry, index) => {
          chars += entry.oldContent.length + entry.newContent.length;
          return index >= 8 || chars > 4 * 1024 * 1024;
        });
        if (excess >= 0) cache.splice(excess);
        job.resolve(data.result);
        if (pending.size === 0) {
          worker?.terminate();
          worker = undefined;
        }
      };
    }
    const id = ++nextId;
    let resolve!: Job['resolve'];
    const promise = new Promise<PreparedDiff>((done) => { resolve = done; });
    const timer = setTimeout(stopWorker, 5_000);
    pending.set(id, { ...input, id, promise, resolve, timer });
    worker.postMessage({ id, input });
    return promise;
  } catch {
    stopWorker();
    return Promise.resolve({ status: 'limited' });
  }
}

export function usePreparedDiff(filePath: string, oldContent: string, newContent: string, enabled = true) {
  const [value, setValue] = useState<(DiffInput & { result: PreparedDiff }) | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    // Coalesce streaming updates; identical title/preview requests share the job.
    const timer = setTimeout(() => {
      void requestDiff({ filePath, oldContent, newContent }).then((result) => {
        if (active) setValue({ filePath, oldContent, newContent, result });
      });
    }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [filePath, oldContent, newContent, enabled]);
  return enabled && value && matches(value, { filePath, oldContent, newContent }) ? value.result : null;
}
