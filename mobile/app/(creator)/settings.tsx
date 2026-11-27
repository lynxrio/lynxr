import { useState } from 'react';
import { Alert, Linking, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { shareInbox } from '../../modules/lynxr-share-inbox';
import { useSession } from '../../src/auth';
import { mobileApi, submissionOutbox } from '../../src/jobs';
import { client, storage } from '../../src/native-client';
import { brand } from '../../src/branding';
import { Button, ErrorText, Screen, styles } from '../../src/ui';
export default function Settings() {
  const session=useSession()!;
  const router=useRouter();
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [requested,setRequested]=useState(false);
  async function deletion() {
    setBusy(true); setError(null);
    try { await mobileApi(client!,session.user.id).deletion(); setRequested(true); }
    catch(e) {setError((e as Error).message);} finally {setBusy(false);}
  }
  async function signOut() {
    setBusy(true); setError(null);
    try {
      await shareInbox.setOwner(null);
      await submissionOutbox(storage,session.user.id).clear();
      const {error}=await client!.auth.signOut({scope:'local'});
      if(error) throw new Error('Couldn’t sign out. Check your connection and try again.');
    } catch(e) {setError((e as Error).message);} finally {setBusy(false);}
  }
  return <Screen>
    <Button secondary label="Back to library" onPress={()=>router.back()}/>
    <Text accessibilityRole="header" style={styles.h1}>Account</Text>
    <Text style={styles.body}>{session.user.email}</Text>
    <ErrorText message={error}/>
    <Button secondary label="Privacy policy" onPress={()=>void Linking.openURL(brand.privacy)}/>
    <Button secondary label="Contact support" onPress={()=>void Linking.openURL(brand.support)}/>
    <Text style={styles.dim}>The initial mobile MVP is free. It has no in-app purchase or upgrade flow.</Text>
    <Button label="Sign out" disabled={busy} onPress={()=>void signOut()}/>
    <Text style={styles.h2}>Delete account</Text>
    <Text style={styles.body}>Request permanent deletion of your entire Lynxr account and associated personal data, including your web account. Fulfillment is manual, within 30 days; we’ll confirm completion by email. This is a deletion request, not immediate deletion. New mobile generation is disabled once requested.</Text>
    {requested ? <Text accessibilityLiveRegion="polite" style={styles.body}>Deletion requested. You may sign out now. Contact support if you have questions.</Text> :
    <Button secondary label="Request account deletion" disabled={busy} onPress={()=>Alert.alert('Delete your Lynxr account?', 'This affects your web account too. Your scripts and account will be permanently removed during fulfillment.',[{text:'Keep account',style:'cancel'},{text:'Request deletion',style:'destructive',onPress:()=>void deletion()}])}/>}
  </Screen>;
}
