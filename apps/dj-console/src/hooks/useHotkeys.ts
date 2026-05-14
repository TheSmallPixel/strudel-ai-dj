import { useEffect } from 'react';

export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return;
      if ((e.target as HTMLElement | null)?.tagName === 'TEXTAREA') return;
      const fn = map[e.key];
      if (fn) {
        fn(e);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [map]);
}
