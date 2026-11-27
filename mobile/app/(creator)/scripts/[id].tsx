import { useLocalSearchParams, useRouter } from 'expo-router';
import { Text, View } from 'react-native';
import { entries, scriptSections, scriptTitle, statusLabel } from '../../../src/contracts';
import { useLibrary } from '../../../src/library';
import { Button, ErrorText, Screen, styles } from '../../../src/ui';

export default function ScriptDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { data, error, loading, refresh } = useLibrary();
  const job = entries(data).find((entry) => entry.id === id);
  const sections = job ? scriptSections(job) : [];
  return <Screen>
    <View style={styles.bar}>
      <Button secondary label="Back to library" onPress={() => router.canGoBack() ? router.back() : router.replace('/')} />
      <Button secondary label={loading ? 'Refreshing…' : 'Refresh'} disabled={loading} onPress={() => void refresh()} />
    </View>
    <Text accessibilityRole="header" style={styles.h1}>{job ? scriptTitle(job, data) : 'Script'}</Text>
    <ErrorText message={error} />
    {!job && !error && <Text style={styles.dim}>{data ? 'This script isn’t in your library.' : 'Loading script…'}</Text>}
    {job && <>
      <View style={styles.card} accessibilityLiveRegion="polite">
        <Text style={styles.kicker}>{statusLabel(job)}</Text>
        {job.status === 'queued' && <Text style={styles.body}>Waiting for the worker. Check your library later.</Text>}
        {job.status === 'running' && <Text style={styles.body}>Your script is being prepared.</Text>}
        {job.status === 'error' && <Text style={styles.body}>
          {job.noteKind && job.note ? job.note : job.retrying ? 'We’ll try again automatically.' : 'This script couldn’t be completed.'}
        </Text>}
        {job.status === 'error' && !job.retrying && <Text style={styles.dim}>Open lynxr.io to manage this script.</Text>}
        {job.status === 'done' && sections.length === 0 && <Text style={styles.dim}>There is no script text available for this video.</Text>}
      </View>
      {sections.map(({ title, lines }) => <View key={title} style={styles.card}>
        <Text accessibilityRole="header" style={styles.h2}>{title}</Text>
        {lines.map((line, index) => <Text key={index} selectable style={styles.body}>{line}</Text>)}
      </View>)}
    </>}
  </Screen>;
}
