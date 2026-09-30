/**
 * Клавіатура. Один слухач на документ у кожного, хто підписався;
 * усі обробники пропускають натискання, зроблені всередині полів введення.
 */

import { useEffect, useRef } from 'react';

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

export type KeyHandler = (event: KeyboardEvent) => void;

/**
 * Карта «клавіша → дія». Ключі — `event.key` (напр. `'j'`, `'?'`, `'Enter'`,
 * `' '` для пробілу, `'Escape'`).
 *
 * @param allowInInputs клавіші, які обробляються навіть у полі введення
 *                      (наприклад `Escape`).
 */
export function useKeyMap(
  map: Record<string, KeyHandler | undefined>,
  options: { enabled?: boolean; allowInInputs?: string[] } = {},
): void {
  const { enabled = true, allowInInputs = ['Escape'] } = options;
  const mapRef = useRef(map);
  mapRef.current = map;
  const allowRef = useRef(allowInInputs);
  allowRef.current = allowInInputs;

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const handler = mapRef.current[event.key];
      if (!handler) return;
      if (isTypingTarget(event.target) && !allowRef.current.includes(event.key)) return;
      handler(event);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}

/** Рух курсором по списку клавішами j / k з утриманням у межах. */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return -1;
  if (index < 0) return 0;
  if (index >= length) return length - 1;
  return index;
}
