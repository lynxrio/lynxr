import type { ReactNode } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export const color = {
  ink: '#14122b', dim: '#5d506a', panel: '#fcf8ff', bg: '#f6eefa',
  edge: '#e6daee', bad: '#942b52', softInk: '#ede4f3',
};

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.bg },
  content: { width: '100%', maxWidth: 620, alignSelf: 'center', padding: 22, paddingBottom: 36, gap: 18 },
  card: { backgroundColor: color.panel, borderColor: color.edge, borderWidth: 1, borderRadius: 22, padding: 18, gap: 12 },
  bar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  grow: { flex: 1, flexBasis: 190 },
  kicker: { color: color.dim, fontSize: 12, fontWeight: '700', letterSpacing: 1.4, textTransform: 'uppercase' },
  h1: { color: color.ink, fontSize: 36, fontWeight: '800', letterSpacing: -1.2 },
  h2: { color: color.ink, fontSize: 21, fontWeight: '700' },
  body: { color: color.ink, fontSize: 16, lineHeight: 23 },
  dim: { color: color.dim, fontSize: 14, lineHeight: 20 },
  error: { color: color.bad, fontSize: 15, lineHeight: 21 },
  input: {
    minHeight: 52, backgroundColor: color.bg, color: color.ink, borderColor: color.edge,
    borderWidth: 1, borderRadius: 13, fontSize: 16, paddingHorizontal: 14, paddingVertical: 10,
  },
  button: { minHeight: 48, justifyContent: 'center', alignItems: 'center', borderRadius: 13, padding: 12, backgroundColor: color.ink },
  secondary: { backgroundColor: color.softInk },
  buttonText: { color: color.panel, fontSize: 16, fontWeight: '700', textAlign: 'center' },
  centered: { justifyContent: 'center', alignItems: 'center', padding: 22, gap: 12 },
  spread: { gap: 8 },
});

export function Screen({ children }: { children: ReactNode }) {
  return <SafeAreaView style={styles.screen} edges={['top', 'bottom', 'left', 'right']}>
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  </SafeAreaView>;
}

export function Button({ label, onPress, secondary, disabled }: {
  label: string; onPress: () => void; secondary?: boolean; disabled?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled}
    onPress={onPress} style={({ pressed }) => [styles.button, secondary && styles.secondary,
      (disabled || pressed) && { opacity: disabled ? 0.52 : 0.82 }]}>
    <Text style={[styles.buttonText, secondary && { color: color.ink }]}>{label}</Text>
  </Pressable>;
}

export function Loading({ label }: { label: string }) {
  return <View style={[styles.screen, styles.centered]} accessibilityLiveRegion="polite">
    <ActivityIndicator color={color.ink} />
    <Text style={styles.dim}>{label}</Text>
  </View>;
}

export function ErrorText({ message }: { message: string | null }) {
  return message ? <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.error}>{message}</Text> : null;
}
