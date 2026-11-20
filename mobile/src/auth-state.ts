import type { Session, SupabaseClient } from '@supabase/supabase-js';

export type AuthState = { session: Session | null; ready: boolean; error: string | null };
type Auth = Pick<SupabaseClient['auth'], 'getSession' | 'onAuthStateChange'>;
const sessionFor = (session: Session | null) => session?.user.is_anonymous ? null : session;

// Keep promise/bootstrap failures out of logs and do not let an old bootstrap
// replace a later sign-in/sign-out event.
export function observeSession(auth: Auth, update: (state: AuthState) => void, hasStorageIssue = () => false) {
  let active = true;
  let revision = 0;
  const { data: { subscription } } = auth.onAuthStateChange((event, next) => {
    if (!active || event === 'INITIAL_SESSION') return;
    revision++;
    update({ session: sessionFor(next), ready: true, error: null });
  });
  const bootstrapRevision = revision;
  void auth.getSession().then(({ data, error }) => {
    if (!active || bootstrapRevision !== revision) return;
    update({
      session: sessionFor(data.session), ready: true,
      error: error || hasStorageIssue() ? 'Couldn’t open the saved session. Unlock your device and try again.' : null,
    });
  }).catch(() => {
    if (!active || bootstrapRevision !== revision) return;
    update({ session: null, ready: true, error: 'Couldn’t open the saved session. Unlock your device and try again.' });
  });
  return () => { active = false; subscription.unsubscribe(); };
}
