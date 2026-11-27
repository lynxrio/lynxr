import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import * as Clipboard from 'expo-clipboard';
import { Alert, Text, View } from 'react-native';
import { entries, scriptSections, scriptTitle, statusLabel } from '../../../src/contracts';
import { useSession } from '../../../src/auth';
import { mobileApi, jobMessage } from '../../../src/jobs';
import { client } from '../../../src/native-client';
import { useLibrary } from '../../../src/library';
import { Button, ErrorText, Screen, styles } from '../../../src/ui';

export default function ScriptDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const session = useSession()!;
  const [actionError, setActionError] = useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [copied,setCopied]=useState(false);
  const { data, error, loading, refresh } = useLibrary();
  const job = entries(data).find((entry) => entry.id === id);
  const sections = job ? scriptSections(job) : [];
  return <Screen>
    <View style={styles.bar}>
      <Button secondary label="Back to library" onPress={() => router.canGoBack() ? router.back() : router.replace('/')} />
      <Button secondary label={loading ? 'Refreshing…' : 'Refresh'} disabled={loading} onPress={() => void refresh()} />
    </View>
    <Text accessibilityRole="header" style={styles.h1}>{job ? scriptTitle(job, data) : 'Script'}</Text>
    <ErrorText message={error || actionError} />
    {!job && !error && <Text style={styles.dim}>{data ? 'This script isn’t in your library.' : 'Loading script…'}</Text>}
    {job && <>
      <View style={styles.card} accessibilityLiveRegion="polite">
        <Text style={styles.kicker}>{statusLabel(job)}</Text>
        {job.status === 'queued' && <Text style={styles.body}>Waiting for the worker. Check your library later.</Text>}
        {job.status === 'running' && <Text style={styles.body}>Your script is being prepared.</Text>}
        {job.status === 'error' && <Text style={styles.body}>
          {job.mobile ? jobMessage(job.note) : job.noteKind && job.note ? job.note : job.retrying ? 'We’ll try again automatically.' : 'This script couldn’t be completed.'}
        </Text>}
        {job.status === 'error' && job.mobile === true && <Button label={busy ? 'Retrying…' : 'Retry processing'} disabled={busy} onPress={() => {
          setBusy(true); setActionError(null);
          void mobileApi(client!,session.user.id).retry(job.id).then(refresh).catch(e=>setActionError(e.message)).finally(()=>setBusy(false));
        }} />}
        {job.status === 'done' && sections.length === 0 && <Text style={styles.dim}>There is no script text available for this video.</Text>}
      </View>
      {!!sections.length && <Button secondary label={copied ? 'Copied' : 'Copy script'} onPress={() => {
        void Clipboard.setStringAsync(sections.map(s=>s.title+'\n'+s.lines.join('\n')).join('\n\n')).then(ok=>{if(ok)setCopied(true);else setActionError('Couldn’t copy this script.');}).catch(()=>setActionError('Couldn’t copy this script.'));
      }} />}
      {job.mobile === true && job.status === 'done' && <Button secondary label="Report an unsafe or inappropriate script" onPress={()=>Alert.alert('Report script?', 'The support team will review this script. Do not use unsafe output.',[{text:'Cancel',style:'cancel'},{text:'Report',onPress:()=>void mobileApi(client!,session.user.id).report(job.id,'Creator flagged unsafe or inappropriate output').then(()=>Alert.alert('Report received')).catch(e=>setActionError(e.message))}])} />}
      {sections.map(({ title, lines }) => <View key={title} style={styles.card}>
        <Text accessibilityRole="header" style={styles.h2}>{title}</Text>
        {lines.map((line, index) => <Text key={index} selectable style={styles.body}>{line}</Text>)}
      </View>)}
    </>}
  </Screen>;
}
