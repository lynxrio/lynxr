import type { Session } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { AppState, Text } from 'react-native';
import { shareInbox } from '../modules/lynxr-share-inbox';
import { observeSession } from './auth-state';
import type { AuthState } from './auth-state';
import { client, storage } from './native-client';
import { Button, ErrorText, Screen, styles } from './ui';

const AuthContext = createContext<Session | null>(null);

export function AuthProvider({ children, loading }: { children: ReactNode; loading: ReactNode }) {
  const [state, setState] = useState<AuthState>({ session: null, ready: false, error: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!client) return;
    const auth = client.auth;
    storage.clearIssue();
    const stop = observeSession(auth, setState, storage.hasIssue);
    const activate = (state: string | null | undefined) => {
      // Supabase handles refresh failures internally. Never log raw auth errors.
      if (state == null || state === 'active') void auth.startAutoRefresh().catch(() => {});
      else void auth.stopAutoRefresh().catch(() => {});
    };
    const listener = AppState.addEventListener('change', activate);
    activate(AppState.currentState);
    return () => {
      stop();
      listener.remove();
      void auth.stopAutoRefresh().catch(() => {});
    };
  }, [attempt]);

  useEffect(() => {
    if (state.ready) void shareInbox.setOwner(state.session?.user.id ?? null).catch(() => {});
  }, [state.ready, state.session?.user.id]);
  if (!state.ready) return loading;
  if (state.error) return <Screen>
    <Text accessibilityRole="header" style={styles.h1}>Open lynxr</Text>
    <ErrorText message={state.error} />
    <Button label="Try again" onPress={() => {
      setState({ session: null, ready: false, error: null });
      setAttempt((n) => n + 1);
    }} />
  </Screen>;
  return <AuthContext.Provider value={state.session}>{children}</AuthContext.Provider>;
}

export function useSession() {
  return useContext(AuthContext);
}
