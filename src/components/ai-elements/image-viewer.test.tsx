// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '@/components/ui/dialog';
import { ImageViewer } from './image-viewer';

// Phone layout: a 400×800 viewport showing a 2000×1000 image, so the fitted scale is 0.2.
beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.matchMedia = ((query: string) => ({
    matches: true, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 400 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalWidth', { configurable: true, get: () => 2000 });
  Object.defineProperty(HTMLImageElement.prototype, 'naturalHeight', { configurable: true, get: () => 1000 });
  Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 800, right: 400, bottom: 800, x: 0, y: 0, toJSON: () => ({}) });
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.hasPointerCapture = () => false;
});

let root: Root;
let container: HTMLDivElement;
let open = true;

function Harness() {
  const [isOpen, setOpen] = useState(true);
  open = isOpen;
  return <Dialog open={isOpen} onOpenChange={setOpen}>{isOpen && <ImageViewer src="blob:shot" filename="shot.png" />}</Dialog>;
}

const canvas = () => document.querySelector<HTMLElement>('[aria-label="Image canvas"]')!;
const image = () => document.querySelector<HTMLImageElement>('img[alt="shot.png"]')!;

function pointer(type: string, id: number, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: id });
  Object.defineProperty(event, 'pointerType', { value: 'touch' });
  act(() => { canvas().dispatchEvent(event); });
}

const tap = (x: number, y: number) => {
  pointer('pointerdown', 1, x, y);
  pointer('pointerup', 1, x, y);
};

beforeEach(async () => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  act(() => { image().dispatchEvent(new Event('load')); });
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  container.remove();
});

describe('phone image viewer gestures', () => {
  it('fits the image edge to edge', () => {
    expect(image().style.transform).toContain('translate(0px, 0px) scale(0.2)');
  });

  it('pinches around the fingers midpoint', () => {
    pointer('pointerdown', 1, 100, 400);
    pointer('pointerdown', 2, 300, 400);
    // Spread from 200px to 400px apart while the midpoint moves 100px right.
    pointer('pointermove', 2, 500, 400);
    expect(image().style.transform).toContain('translate(100px, 0px) scale(0.4)');
    pointer('pointerup', 2, 500, 400);
    pointer('pointerup', 1, 100, 400);
    expect(image().style.transform).toContain('scale(0.4)');
  });

  it('springs back to fit when pinched smaller than the screen', () => {
    pointer('pointerdown', 1, 100, 400);
    pointer('pointerdown', 2, 300, 400);
    pointer('pointermove', 2, 200, 400);
    expect(image().style.transform).toContain('scale(0.1)');
    pointer('pointerup', 2, 200, 400);
    pointer('pointerup', 1, 100, 400);
    expect(image().style.transform).toContain('translate(0px, 0px) scale(0.2)');
  });

  it('double tap zooms in, and again returns to fit', () => {
    tap(200, 400);
    tap(200, 400);
    expect(image().style.transform).toContain('scale(0.5)');
    tap(200, 400);
    tap(200, 400);
    expect(image().style.transform).toContain('scale(0.2)');
  });

  it('a single tap toggles the controls', () => {
    vi.useFakeTimers();
    const close = () => document.querySelector<HTMLElement>('[aria-label="Close image preview"]')!;
    tap(200, 400);
    act(() => { vi.advanceTimersByTime(300); });
    expect(close().className).toContain('opacity-0');
    tap(200, 400);
    act(() => { vi.advanceTimersByTime(300); });
    expect(close().className).not.toContain('opacity-0');
  });

  it('closes on a long drag down and springs back on a short one', () => {
    pointer('pointerdown', 1, 200, 400);
    pointer('pointermove', 1, 200, 460);
    expect(image().style.transform).toContain('translate(0px, 60px)');
    pointer('pointerup', 1, 200, 460);
    expect(open).toBe(true);
    expect(image().style.transform).toContain('translate(0px, 0px)');

    pointer('pointerdown', 1, 200, 400);
    pointer('pointermove', 1, 200, 450);
    pointer('pointermove', 1, 200, 600);
    pointer('pointerup', 1, 200, 600);
    expect(open).toBe(false);
  });

  it('pans a zoomed image instead of dismissing it', () => {
    tap(200, 400);
    tap(200, 400);
    // At 0.5 the image is 1000×500: wider than the screen, shorter than it.
    pointer('pointerdown', 1, 200, 400);
    pointer('pointermove', 1, 200, 600);
    pointer('pointerup', 1, 200, 600);
    expect(open).toBe(true);
    pointer('pointerdown', 1, 200, 400);
    pointer('pointermove', 1, 300, 400);
    pointer('pointerup', 1, 300, 400);
    expect(image().style.transform).toContain('translate(100px, 0px) scale(0.5)');
  });
});
