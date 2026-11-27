import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Text } from 'react-native';
import { AuthProvider, useSession } from '../src/auth';
import { client } from '../src/native-client';
import { Loading, Screen, styles } from '../src/ui';

function Routes() {
  const session = useSession();
  return <Stack screenOptions={{ headerShown: false }}>
    <Stack.Protected guard={!session}>
      <Stack.Screen name="sign-in" />
    </Stack.Protected>
    <Stack.Protected guard={!!session}>
      <Stack.Screen name="(creator)" />
    </Stack.Protected>
  </Stack>;
}

export default function RootLayout() {
  return <>
    <StatusBar style="dark" />
    {process.env.EXPO_PUBLIC_LOCAL_TEST === '1' && <Text style={[styles.dim, {padding: 12, paddingTop: 56}]}>Local test environment • No paid inference</Text>}
    {client ? <AuthProvider loading={<Loading label="Opening lynxr…" />}><Routes /></AuthProvider>
      : <Screen>
        <Text accessibilityRole="header" style={styles.h1}>lynxr</Text>
        <Text style={styles.body}>This build hasn’t been connected to a Lynxr environment.</Text>
      </Screen>}
  </>;
}
