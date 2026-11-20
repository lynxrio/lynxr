import { useRouter } from 'expo-router';
import { useMemo, useRef, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSession } from '../../src/auth';
import { entries, scriptTitle, statusLabel } from '../../src/contracts';
import { useLibrary } from '../../src/library';
import { client } from '../../src/native-client';
import { Button, ErrorText, Screen, styles } from '../../src/ui';

export default function Home() {
  const router = useRouter();
  const session = useSession();
  const { data, error, loading, refresh } = useLibrary();
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const lock = useRef(false);
  const jobs = useMemo(() => entries(data)
    .sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || '')), [data]);

  async function signOut() {
    if (lock.current) return;
    lock.current = true;
    setSignOutError(null);
    setSigningOut(true);
    try {
      const result = await client!.auth.signOut({ scope: 'local' });
      if (result.error) setSignOutError('Couldn’t sign out. Check your connection and try again.');
    } catch {
      setSignOutError('Couldn’t sign out. Check your connection and try again.');
    } finally {
      setSigningOut(false);
      lock.current = false;
    }
  }

  return <Screen>
    <View style={styles.bar}>
      <Text style={styles.kicker}>Lynxr / Companion</Text>
      <Button secondary label={signingOut ? 'Signing out…' : 'Sign out'} disabled={signingOut} onPress={signOut} />
    </View>
    <Text accessibilityRole="header" style={styles.h1}>Your scripts</Text>
    <Text style={styles.dim}>{session?.user.email}</Text>
    <Text style={styles.body}>Read your existing scripts here. Make and edit scripts on lynxr.io.</Text>
    <ErrorText message={signOutError} />
    <Button secondary label={loading ? 'Refreshing…' : 'Refresh library'} disabled={loading}
      onPress={() => void refresh()} />
    <ErrorText message={error} />
    {!jobs.length && !error && <Text style={styles.dim}>{data ? 'Your saved scripts will appear here.' : 'Loading your library…'}</Text>}
    {jobs.map((job) => <Pressable key={job.id} accessibilityRole="button"
      onPress={() => router.push({ pathname: '/scripts/[id]', params: { id: job.id } })} style={styles.card}>
      <Text style={styles.kicker}>{statusLabel(job)}</Text>
      <Text style={styles.body}>{scriptTitle(job, data)}</Text>
      {!!job.brandName && <Text style={styles.dim}>{job.brandName}</Text>}
    </Pressable>)}
  </Screen>;
}
