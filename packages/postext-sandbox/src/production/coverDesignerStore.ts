// Whether the cover designer is open: it is opened from the Cover panel and
// from the book's preview, and drawn once, over the whole Sandbox.

import { useSyncExternalStore } from 'react';

let open = false;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const l of listeners) l();
}

export const openCoverDesigner = (): void => set(true);
export const closeCoverDesigner = (): void => set(false);

export function useCoverDesignerOpen(): boolean {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => open,
    () => false,
  );
}
