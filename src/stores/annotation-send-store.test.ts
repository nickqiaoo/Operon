import { afterEach, describe, expect, it } from 'vitest';
import { useAnnotationSendStore } from './annotation-send-store';

afterEach(() => useAnnotationSendStore.getState().consume());

describe('annotation send requests', () => {
  it('consumes the entire request and emits another request for a null workspace', () => {
    const seen: number[] = [];
    const unsubscribe = useAnnotationSendStore.subscribe((state) => seen.push(state.nonce));
    try {
      useAnnotationSendStore.getState().requestSend(42);
      expect(useAnnotationSendStore.getState()).toMatchObject({ workspaceId: 42, nonce: 1 });
      useAnnotationSendStore.getState().consume();
      expect(useAnnotationSendStore.getState()).toMatchObject({ workspaceId: null, nonce: 0 });
      useAnnotationSendStore.getState().requestSend(null);
      expect(useAnnotationSendStore.getState()).toMatchObject({ workspaceId: null, nonce: 1 });
      expect(seen).toEqual([1, 0, 1]);
    } finally {
      unsubscribe();
    }
  });
});
