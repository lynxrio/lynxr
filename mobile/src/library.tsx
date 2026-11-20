import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';
import { creatorApi } from './creator-api';
import { entries, hasWork } from './contracts';
import { libraryStore } from './library-store';
import type { LibraryState } from './library-store';
import { client } from './native-client';

type Library = LibraryState & { refresh: () => Promise<void> };
const LibraryContext = createContext<Library | null>(null);

export function LibraryProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const store = useMemo(() => libraryStore(creatorApi(client!, userId).read), [userId]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [foreground, setForeground] = useState(AppState.currentState == null || AppState.currentState === 'active');

  useEffect(() => {
    const listener = AppState.addEventListener('change', (next) => setForeground(next === 'active'));
    return () => { listener.remove(); };
  }, []);
  useEffect(() => {
    store.activate();
    return () => store.deactivate();
  }, [store]);
  useEffect(() => { if (foreground) void store.refresh(); }, [foreground, store]);
  const active = entries(state.data).some(hasWork);
  useEffect(() => {
    if (!foreground) return;
    const timer = setInterval(() => {
      if (!store.getSnapshot().loading) void store.refresh();
    }, active ? 15000 : 60000);
    return () => clearInterval(timer);
  }, [active, foreground, store]);

  return <LibraryContext.Provider value={{ ...state, refresh: store.refresh }}>
    {children}
  </LibraryContext.Provider>;
}

export function useLibrary(): Library {
  const state = useContext(LibraryContext);
  if (!state) throw new Error('Library is available only in a signed-in route');
  return state;
}
