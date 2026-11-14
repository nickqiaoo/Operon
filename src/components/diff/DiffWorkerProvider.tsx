import { useEffect, type ReactNode } from 'react';
import { WorkerPoolContextProvider, useWorkerPool } from '@pierre/diffs/react';
import type { WorkerInitializationRenderOptions, WorkerPoolOptions } from '@pierre/diffs/react';
import PierreDiffWorker from '@pierre/diffs/worker/worker.js?worker';
import { PIERRE_THEME } from '@shared/tool-rendering/pierre-theme';
import { useReviewDisplayStore } from '@/stores/review-display-store';

const poolOptions: WorkerPoolOptions = { workerFactory: () => new PierreDiffWorker() };
const highlighterOptions: WorkerInitializationRenderOptions = { theme: PIERRE_THEME, lineDiffType: 'none' };

// Pierre uses a singleton pool. Every consumer must agree on its render options.
function SyncRenderOptions() {
  const pool = useWorkerPool();
  const wordDiff = useReviewDisplayStore((s) => s.wordDiff);
  useEffect(() => {
    if (!pool) return;
    void pool.setRenderOptions({ ...pool.getDiffRenderOptions(), lineDiffType: wordDiff ? 'word' : 'none' })
      .catch((error: unknown) => console.error('Failed to update diff highlighting', error));
  }, [pool, wordDiff]);
  return null;
}

export function DiffWorkerProvider({ children }: { children: ReactNode }) {
  return (
    <WorkerPoolContextProvider poolOptions={poolOptions} highlighterOptions={highlighterOptions}>
      <SyncRenderOptions />
      {children}
    </WorkerPoolContextProvider>
  );
}
