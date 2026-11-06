import { useSyncExternalStore } from 'react';

/** One short message at the bottom of the screen ("Added to Road trip"), like Spotify's. */
let current: { text: string; id: number } | null = null;
let timer = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(text: string): void {
  current = { text, id: (current?.id ?? 0) + 1 };
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    current = null;
    emit();
  }, 3000);
  emit();
}

export function Toasts() {
  const t = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
  return t ? (
    <div className="toast" role="status" key={t.id}>
      {t.text}
    </div>
  ) : null;
}
