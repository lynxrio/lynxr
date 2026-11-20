import type { CreatorData } from './contracts';

export type LibraryState = { data?: CreatorData; error: string | null; loading: boolean };

// Per-account, memory-only state. deactivate invalidates late responses and clears
// the snapshot; this store is never shared between authenticated route trees.
export function libraryStore(read: () => Promise<CreatorData>) {
  let snapshot: LibraryState = { error: null, loading: false };
  let version = 0;
  let active = true;
  const listeners = new Set<() => void>();
  const publish = (next: LibraryState) => {
    snapshot = next;
    listeners.forEach((notify) => notify());
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(notify: () => void) {
      listeners.add(notify);
      return () => { listeners.delete(notify); };
    },
    async refresh() {
      if (!active) return;
      const request = ++version;
      publish({ ...snapshot, loading: true, error: null });
      try {
        const data = await read();
        if (active && request === version) publish({ data, error: null, loading: false });
      } catch {
        if (active && request === version) publish({
          ...snapshot, error: 'Couldn’t refresh your library. Check your connection and try again.', loading: false,
        });
      }
    },
    activate() { active = true; },
    deactivate() {
      active = false;
      version++;
      publish({ error: null, loading: false });
    },
  };
}
