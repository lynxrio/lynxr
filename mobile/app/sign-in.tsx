import { useRef, useState } from 'react';
import { Keyboard, Text, TextInput, View } from 'react-native';
import { client, storage } from '../src/native-client';
import { Button, color, ErrorText, Screen, styles } from '../src/ui';

export default function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);

  async function submit() {
    if (!client || lock.current || !email.trim() || !password) return;
    lock.current = true;
    Keyboard.dismiss();
    setBusy(true);
    setError(null);
    storage.clearIssue();
    try {
      const result = await client.auth.signInWithPassword({ email: email.trim(), password });
      if (result.error) {
        setError(result.error.code === 'invalid_credentials'
          ? 'Check your email and password and try again.'
          : result.error.code === 'email_not_confirmed'
            ? 'Confirm your email on lynxr.io before signing in.'
            : 'Couldn’t sign in right now. Check your connection and try again.');
      } else setPassword('');
    } catch {
      setError(storage.hasIssue() ? 'Couldn’t save a secure session. Unlock your device and try again.' : 'Couldn’t sign in right now. Try again.');
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return <Screen>
    <Text style={styles.kicker}>Lynxr</Text>
    <Text accessibilityRole="header" style={styles.h1}>Sign in</Text>
    <Text style={styles.body}>Use the email and password for your existing Lynxr account.</Text>
    <View style={styles.card}>
      <Text style={styles.kicker}>Email</Text>
      <TextInput accessibilityLabel="Email" style={styles.input} value={email} onChangeText={setEmail}
        placeholder="you@example.com" placeholderTextColor={color.dim} autoCapitalize="none"
        autoCorrect={false} keyboardType="email-address" autoComplete="email" editable={!busy} />
      <Text style={styles.kicker}>Password</Text>
      <TextInput accessibilityLabel="Password" style={styles.input} value={password} onChangeText={setPassword}
        secureTextEntry autoCapitalize="none" autoComplete="current-password" editable={!busy}
        returnKeyType="go" onSubmitEditing={submit} />
      <ErrorText message={error} />
      <Button label={busy ? 'Signing in…' : 'Sign in'} disabled={busy || !email.trim() || !password} onPress={submit} />
    </View>
    <Text style={styles.dim}>This internal MVP uses existing email/password test accounts. Ask the team for an approved test account.</Text>
  </Screen>;
}
