import { createClient } from '@supabase/supabase-js';
import type { SupabaseClientOptions } from '@supabase/supabase-js';
import type { Database } from './contracts';

// Prevent accidental queue, profile, storage, RPC or billing writes even if a
// future caller bypasses the read-only database types.
export function readOnlyTransport(origin: string, request: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
    const allowed = url.origin === new URL(origin).origin && (
      (method === 'GET' && url.pathname === '/rest/v1/lynxr_creators')
      || (method === 'POST' && url.pathname === '/auth/v1/token'
        && ['password', 'refresh_token'].includes(url.searchParams.get('grant_type') ?? ''))
      || (method === 'POST' && url.pathname === '/auth/v1/logout' && url.searchParams.get('scope') === 'local')
    );
    if (!allowed) throw new Error('This companion only supports signing in, signing out, and reading scripts.');
    return request(input, init);
  };
}

export function createLynxrClient(url: string, key: string,
  storage: NonNullable<SupabaseClientOptions<'public'>['auth']>['storage'], request: typeof fetch = fetch) {
  return createClient<Database>(url, key, {
    auth: { storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    global: { fetch: readOnlyTransport(url, request) },
  });
}
