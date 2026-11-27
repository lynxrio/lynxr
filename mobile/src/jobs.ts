import type { SupabaseClient } from '@supabase/supabase-js';
import type { Adaptation, Database } from './contracts';
import { videoUrl } from './video-url';

export type Brand = { id: string; name: string; description?: string };
export type Snapshot = { enabled: boolean; deletionPending: boolean; brands: Brand[]; jobs: Adaptation[];
  allowance: { used: number; granted: number; plan: string; next_room_at?: string | null } };
export type Submission = { id: string; userId: string; url: string; brand: string; consent: true };
export type DurableStorage = { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void>; removeItem(key: string): Promise<void> };

const messages: Record<string, string> = {
  allowance_exhausted: 'Your free allowance is used. Try again after your allowance renews.',
  mobile_unavailable: 'Generation is not enabled for this environment yet. Your library remains available.',
  free_release_only: 'This initial release supports free accounts. Contact support for access.',
  deletion_pending: 'Account deletion is pending. New generation is disabled.',
  source_unavailable: 'This video could not be accessed. Check that the link is public and you have permission to use it.',
  processing_failed: 'Processing failed. Retry when you’re ready; the failed charge was returned.',
  interrupted: 'Processing was interrupted. Retry to resume with a new attempt.',
  retry_limit: 'This job reached its retry limit. Contact support.',
  idempotency_conflict: 'This saved request changed. Contact support before trying again.',
};
export function jobMessage(code?: string) { return code && messages[code] || 'Couldn’t complete the request. Check your connection and try again.'; }

export function mobileApi(client: SupabaseClient<Database>, userId: string) {
  async function owner() {
    const { data, error } = await client.auth.getSession();
    if (error || !data.session || data.session.user.is_anonymous || data.session.user.id !== userId)
      throw new Error('Your account changed. Sign in again.');
  }
  async function call<T>(name: keyof Database['public']['Functions'], args?: Record<string, unknown>): Promise<T> {
    await owner();
    // The narrow RPC union is fixed by this module, never caller-controlled URLs.
    const { data, error } = await client.rpc(name, args as never);
    await owner();
    if (error) throw new Error(jobMessage(error.message));
    return data as T;
  }
  return {
    snapshot: () => call<Snapshot>('mobile_snapshot'),
    submit: (s: Submission) => {
      if (s.userId !== userId) throw new Error('This request belongs to another account.');
      return call<string>('mobile_submit_job', { p_id: s.id, p_url: videoUrl(s.url), p_brand: s.brand, p_consent: s.consent });
    },
    retry: (id: string) => call<string>('mobile_retry_job', { p_id: id }),
    brand: (id: string, name: string, description: string) => call<string>('mobile_create_brand', { p_id: id, p_name: name.trim(), p_description: description.trim() }),
    deletion: () => call<string>('mobile_request_deletion'),
    report: (id: string, reason: string) => call<null>('mobile_report_script', { p_id: id, p_reason: reason }),
  };
}

/** Persist before sending; network ambiguity retains the original idempotency UUID. */
export function submissionOutbox(storage: DurableStorage, userId: string) {
  const key = `lynxr.pending.${userId}`;
  return {
    async load(): Promise<Submission | null> {
      const raw = await storage.getItem(key);
      if (!raw) return null;
      const s = JSON.parse(raw) as Submission;
      if (s.userId !== userId || typeof s.id !== 'string' || s.consent !== true || typeof s.brand !== 'string')
        throw new Error('Saved request is invalid.');
      videoUrl(s.url);
      return s;
    },
    async save(s: Submission) {
      if (s.userId !== userId) throw new Error('Account mismatch');
      const old = await this.load();
      if (old && JSON.stringify(old) !== JSON.stringify(s)) throw new Error('Resolve your pending request first.');
      await storage.setItem(key, JSON.stringify(s));
    },
    clear: () => storage.removeItem(key),
  };
}
