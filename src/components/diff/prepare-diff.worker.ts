import { prepareDiff, type DiffInput, type PreparedDiff } from './prepare-diff';

self.onmessage = ({ data }: MessageEvent<{ id: number; input: DiffInput }>) => {
  let result: PreparedDiff;
  try {
    result = prepareDiff(data.input);
  } catch {
    result = { status: 'limited' };
  }
  self.postMessage({ id: data.id, result });
};
