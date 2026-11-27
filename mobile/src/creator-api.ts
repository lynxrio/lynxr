import type { SupabaseClient } from '@supabase/supabase-js';
import type { CreatorData, Database } from './contracts';

export class LibraryError extends Error {}

export function creatorApi(client: SupabaseClient<Database>, userId: string) {
  return {
    async read(): Promise<CreatorData> {
      const { data: { session }, error: sessionError } = await client.auth.getSession();
      if (sessionError || !session || session.user.is_anonymous || session.user.id !== userId) {
        throw new LibraryError('Sign in again to open your library.');
      }
      const { data, error } = await client.from('lynxr_creators')
        .select('id,data,updated_at').eq('id', userId).maybeSingle();
      // Recheck after the request: never deliver an account's result after a
      // sign-out/account switch while the request was in flight.
      const current = await client.auth.getSession();
      if (current.data.session?.user.id !== userId || current.error) {
        throw new LibraryError('Your account changed. Open the library again.');
      }
      if (error || (data && data.id !== userId)) {
        throw new LibraryError('Couldn’t load your library. Check your connection and try again.');
      }
      return data?.data ?? {};
    },
  };
}

export type CreatorApi = ReturnType<typeof creatorApi>;
