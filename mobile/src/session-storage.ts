type Storage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};
type Cipher = {
  generateKey(): Promise<string>;
  encrypt(value: string, key: string): Promise<string>;
  decrypt(value: string, key: string): Promise<string>;
};

export function sessionStorage(values: Storage, keys: Storage, cipher: Cipher) {
  const keyName = (key: string) => 'lynxr.v1.' + key;
  let unavailable = false;
  return {
    hasIssue: () => unavailable,
    clearIssue: () => { unavailable = false; },
    async getItem(key: string) {
      let value: string | null;
      let secret: string | null;
      try {
        value = await values.getItem(keyName(key));
        if (!value) return null;
        secret = await keys.getItem(keyName(key));
      } catch {
        // Supabase logs raw errors from storage initialization. Return no
        // session and expose a separate, sanitized bootstrap failure instead.
        unavailable = true;
        return null;
      }
      if (!secret) return null; // Ciphertext restored without its device key.
      try {
        return await cipher.decrypt(value, secret);
      } catch {
        return null; // Corrupt/authentication-failed ciphertext is signed out.
      }
    },
    async setItem(key: string, value: string) {
      try {
        const name = keyName(key);
        let secret = await keys.getItem(name);
        if (!secret) {
          secret = await cipher.generateKey();
          await keys.setItem(name, secret);
        }
        await values.setItem(name, await cipher.encrypt(value, secret));
      } catch {
        unavailable = true;
        throw new Error('Secure session storage is unavailable.');
      }
    },
    async removeItem(key: string) {
      try {
        const name = keyName(key);
        await keys.removeItem(name);
        await values.removeItem(name);
      } catch {
        unavailable = true;
        throw new Error('Secure session storage is unavailable.');
      }
    },
  };
}
