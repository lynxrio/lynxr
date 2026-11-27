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
  storage: NonNullable<SupabaseClientOptions<'public'>['auth']>['storage'], request: typeof fetch = fetch, mobile = false) {
  return createClient<Database>(url, key, {
    auth: { storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    global: { fetch: mobile ? mobileTransport(url, request) : readOnlyTransport(url, request) },
  });
}

const mobileRPCs = new Set(['mobile_snapshot', 'mobile_submit_job', 'mobile_retry_job', 'mobile_create_brand', 'mobile_request_deletion', 'mobile_report_script']);
export function mobileTransport(origin: string, request: typeof fetch): typeof fetch {
  return async (input, init) => {
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
    const rpc = u.pathname.startsWith('/rest/v1/rpc/') && mobileRPCs.has(u.pathname.slice('/rest/v1/rpc/'.length));
    const token = u.pathname === '/auth/v1/token' && u.searchParams.getAll('grant_type').length === 1 && ['password', 'refresh_token'].includes(u.searchParams.get('grant_type')!);
    const logout = u.pathname === '/auth/v1/logout' && u.searchParams.getAll('scope').length === 1 && u.searchParams.get('scope') === 'local';
    const allowed = u.origin === new URL(origin).origin && !u.username && !u.password && !u.hash && (
      method === 'GET' && u.pathname === '/rest/v1/lynxr_creators' ||
      method === 'POST' && (rpc && !u.search || token && [...u.searchParams.keys()].every(k => k === 'grant_type') || logout && [...u.searchParams.keys()].every(k => k === 'scope')));
    if (!allowed) throw new Error('Request is outside the mobile contract.');
    return request(input, { ...init, redirect: 'error' });
  };
}
