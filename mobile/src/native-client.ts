import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AESEncryptionKey, AESSealedData, aesDecryptAsync, aesEncryptAsync } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { localTestHost } from './environment';
import { createLynxrClient } from './client';
import { sessionStorage } from './session-storage';

const secure = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
export const storage = sessionStorage(AsyncStorage, {
  getItem: (key) => SecureStore.getItemAsync(key, secure),
  setItem: (key, value) => SecureStore.setItemAsync(key, value, secure),
  removeItem: (key) => SecureStore.deleteItemAsync(key, secure),
}, {
  generateKey: async () => (await AESEncryptionKey.generate()).encoded('hex'),
  async encrypt(value, key) {
    const encrypted = await aesEncryptAsync(btoa(encodeURIComponent(value)), await AESEncryptionKey.import(key, 'hex'));
    return encrypted.combined('base64');
  },
  async decrypt(value, key) {
    const decoded = await aesDecryptAsync(AESSealedData.fromCombined(value),
      await AESEncryptionKey.import(key, 'hex'), { output: 'base64' });
    if (typeof decoded !== 'string') throw new Error('Invalid session encoding');
    return decodeURIComponent(atob(decoded));
  },
});

function configuredClient() {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !key?.startsWith('sb_publishable_')) return null;
  try {
    const parsed = new URL(url);
    const local = process.env.EXPO_PUBLIC_LOCAL_TEST === '1' && localTestHost(parsed.hostname);
    if ((!local && parsed.protocol !== 'https:') || parsed.origin !== url.replace(/\/$/, '')) return null;
    return createLynxrClient(url, key, storage, fetch, true);
  } catch {
    return null;
  }
}

export const client = configuredClient();
