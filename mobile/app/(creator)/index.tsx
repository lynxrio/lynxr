import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useSession } from '../../src/auth';
import { entries, scriptTitle, statusLabel } from '../../src/contracts';
import { useLibrary } from '../../src/library';
import { Button, ErrorText, Screen, styles } from '../../src/ui';

export default function Home() {
  const router = useRouter();
  const session = useSession();
  const { data, error, loading, refresh } = useLibrary();
  const jobs = useMemo(() => entries(data)
    .sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || '')), [data]);


  return <Screen>
    <View style={styles.bar}>
      <Text style={styles.kicker}>Lynxr</Text>
      <Button secondary label="Account" onPress={() => router.push('/settings')} />
    </View>
    <Text accessibilityRole="header" style={styles.h1}>Your scripts</Text>
    <Text style={styles.dim}>{session?.user.email}</Text>
    <Button label="Make a script / Shared links" onPress={() => router.push('/create')} />
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
