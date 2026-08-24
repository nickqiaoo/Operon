import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/** Shared hook for portal-based floating panels */
export function useFloatingPanel() {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);

  const updatePos = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    setPos({ left: rect.left, bottom: window.innerHeight - rect.top + 6 });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePos();
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open, updatePos]);

  const toggle = useCallback(() => setOpen((v) => !v), []);
  const close = useCallback(() => setOpen(false), []);

  return { open, setOpen, toggle, close, btnRef, panelRef, pos };
}

export const panelCn = (open: boolean, hasPos: boolean) =>
  cn(
    'fixed z-50 origin-bottom transition-all duration-200 ease-out',
    open && hasPos
      ? 'opacity-100 scale-100 translate-y-0'
      : 'opacity-0 scale-95 translate-y-1 pointer-events-none'
  );

export const panelInnerCn = 'rounded-xl bg-background/95 backdrop-blur-lg shadow-lg ring-1 ring-black/5 dark:ring-white/10 p-1';
