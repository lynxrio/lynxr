import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Switch, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import { shareInbox } from '../../modules/lynxr-share-inbox';
import type { SharedLink } from '../../modules/lynxr-share-inbox';
import { useSession } from '../../src/auth';
import { useLibrary } from '../../src/library';
import { mobileApi, submissionOutbox } from '../../src/jobs';
import type { Brand, Snapshot, Submission } from '../../src/jobs';
import { client, storage } from '../../src/native-client';
import { videoUrl } from '../../src/video-url';
import { Button, ErrorText, Screen, styles } from '../../src/ui';

export default function Create() {
  const session = useSession()!;
  const router = useRouter();
  const { data, refresh } = useLibrary();
  const api = useMemo(() => mobileApi(client!, session.user.id), [session.user.id]);
  const outbox = useMemo(() => submissionOutbox(storage, session.user.id), [session.user.id]);
  const snapshot = data?.mobile as Snapshot | undefined;
  const brands = [...(Array.isArray(data?.brands) ? data.brands as Brand[] : []), ...(snapshot?.brands ?? [])];
  const [url, setUrl] = useState('');
  const [brand, setBrand] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [consent, setConsent] = useState(false);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [pending, setPending] = useState<Submission | null>(null);
  const [shared, setShared] = useState<SharedLink[]>([]);
  const [selectedShare, setSelectedShare] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const brandRequest = useRef<{ id: string; name: string; description: string } | null>(null);
  useEffect(() => {
    let current = true;
    async function restore() {
      try {
        await shareInbox.setOwner(session.user.id);
        const [links, saved] = await Promise.all([shareInbox.list(session.user.id), outbox.load()]);
        if (!current) return;
        setShared(links);
        if (saved) { setPending(saved); setUrl(saved.url); setBrand(saved.brand); setConsent(true); setConfirmed(saved.url); }
      } catch { if (current) setError('Couldn’t restore saved links. Try again after unlocking your phone.'); }
    }
    void restore();
    const listener = AppState.addEventListener('change', s => { if (s === 'active') void restore(); });
    return () => { current = false; listener.remove(); };
  }, [session.user.id, outbox]);
  async function perform(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : 'Couldn’t complete this request.'); }
    finally { lock.current = false; setBusy(false); }
  }
  function confirm() {
    try { setConfirmed(videoUrl(url)); setError(null); } catch(e) { setError((e as Error).message); }
  }
  async function send() {
    if (!confirmed || !consent) return;
    const s = pending ?? { id: randomUUID(), userId: session.user.id, url: confirmed, brand, consent: true as const };
    await outbox.save(s); setPending(s);
    if (selectedShare) await shareInbox.acknowledge(selectedShare, session.user.id);
    const id = await api.submit(s);
    await outbox.clear(); setPending(null);
    await refresh(); router.replace({ pathname: '/scripts/[id]', params: { id } });
  }
  return <Screen>
    <Button secondary label="Back to library" onPress={() => router.back()} />
    <Text accessibilityRole="header" style={styles.h1}>Make a script</Text>
    <ErrorText message={error} />
    {!snapshot?.enabled && <Text style={styles.dim}>Generation needs the approved mobile backend enabled. You can prepare a link here.</Text>}
    {shared.map(link => <View key={link.id} style={styles.card}>
      <Text selectable style={styles.dim}>{link.url}</Text>
      {!link.owner && <Text style={styles.dim}>Shared while signed out. Confirm this is intended for your current account.</Text>}
      <Button secondary label="Use shared link" disabled={!!pending || busy} onPress={() => { setUrl(link.url); setSelectedShare(link.id); setConfirmed(null); }} />
      <Button secondary label="Discard shared link" disabled={busy} onPress={() => void perform(async () => { await shareInbox.acknowledge(link.id, session.user.id); setShared(await shareInbox.list(session.user.id)); })} />
    </View>)}
    <Text style={styles.kicker}>Instagram / TikTok video URL</Text>
    <TextInput accessibilityLabel="Video URL" style={styles.input} value={url} autoCapitalize="none" autoCorrect={false} keyboardType="url" editable={!busy && !pending} onChangeText={v => { setUrl(v); setConfirmed(null); }} />
    <Text style={styles.h2}>Intended brand</Text>
    <Button secondary label={brand === '' ? '✓ Original script (no brand)' : 'Original script (no brand)'} disabled={!!pending || busy} onPress={() => { setBrand(''); setConfirmed(null); }} />
    {brands.map(b => <Button key={b.id} secondary label={`${brand === b.id ? '✓ ' : ''}${b.name}`} disabled={!!pending || busy} onPress={() => { setBrand(b.id); setConfirmed(null); }} />)}
    {!pending && <View style={styles.card}>
      <Text style={styles.h2}>New brand</Text>
      <TextInput accessibilityLabel="Brand name" placeholder="Brand name" style={styles.input} value={name} maxLength={120} editable={!busy} onChangeText={setName} />
      <TextInput accessibilityLabel="Brand description" placeholder="What you sell, for whom, and your tone" style={styles.input} value={description} multiline maxLength={4000} editable={!busy} onChangeText={setDescription} />
      <Button secondary label="Save brand" disabled={busy || !name.trim() || !description.trim() || !snapshot?.enabled} onPress={() => void perform(async () => {
        const old = brandRequest.current;
        const request = old && old.name === name && old.description === description ? old : { id: randomUUID(), name, description };
        brandRequest.current = request;
        const id = await api.brand(request.id, name, description);
        setBrand(id); setConfirmed(null); setName(''); setDescription(''); brandRequest.current = null; await refresh();
      })} />
    </View>}
    <View style={styles.card}>
      <Text style={styles.body}>I own or have permission to use this content and brand. I agree to send this link, extracted video/audio and brand details to Lynxr’s processing providers, including Anthropic, to generate a script. I’ll review the result for accuracy and rights before using it.</Text>
      <Switch accessibilityLabel="Content rights and AI processing consent" value={consent} disabled={busy || !!pending} onValueChange={setConsent} />
    </View>
    {!confirmed && <Button label="Review source and brand" disabled={!url || busy} onPress={confirm} />}
    {confirmed && <View style={styles.card}>
      <Text style={styles.h2}>Confirm generation</Text>
      <Text selectable style={styles.body}>{confirmed}</Text>
      <Text style={styles.body}>{brands.find(b => b.id === brand)?.name || 'Original script • no brand'}</Text>
      <Text style={styles.dim}>Uses one available free script. Repeated taps reuse this request. Failed processing returns the allowance.</Text>
      {pending && <Text style={styles.dim}>A saved request is awaiting confirmation from the server. Retry it to recover the original job.</Text>}
      <Button label={busy ? 'Sending…' : pending ? 'Recover saved submission' : 'Generate script'} disabled={busy || !consent || !snapshot?.enabled || snapshot.deletionPending} onPress={() => void perform(send)} />
      {pending && <Button secondary label="Forget saved request" disabled={busy} onPress={() => Alert.alert('Forget this recovery request?', 'The server may already have accepted it. Refresh your library before making another request. Matching source and brand are deduplicated by the server.', [{text:'Keep request',style:'cancel'},{text:'Forget',onPress:() => void perform(async()=>{await outbox.clear();setPending(null);setConfirmed(null);await refresh();})}])} />}
      {!pending && <Button secondary label="Edit request" disabled={busy} onPress={() => setConfirmed(null)} />}
    </View>}
  </Screen>;
}
