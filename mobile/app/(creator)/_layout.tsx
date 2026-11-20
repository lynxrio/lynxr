import { Stack } from 'expo-router';
import { useSession } from '../../src/auth';
import { LibraryProvider } from '../../src/library';

export default function CreatorLayout() {
  const session = useSession();
  if (!session) return null;
  return <LibraryProvider key={session.user.id} userId={session.user.id}>
    <Stack screenOptions={{ headerShown: false }} />
  </LibraryProvider>;
}
