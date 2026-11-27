import { requireOptionalNativeModule } from 'expo-modules-core';
export type SharedLink = { id: string; url: string; owner?: string | null; createdAt: string };
const native = requireOptionalNativeModule<{
  setOwner(owner: string | null): Promise<void>;
  list(owner: string): Promise<string>;
  acknowledge(id: string, owner: string): Promise<void>;
}>('LynxrShareInbox');
export const shareInbox = {
  setOwner: (owner: string | null) => native?.setOwner(owner) ?? Promise.resolve(),
  list: async (owner: string): Promise<SharedLink[]> => native ? JSON.parse(await native.list(owner)) : [],
  acknowledge: (id: string, owner: string) => native?.acknowledge(id, owner) ?? Promise.resolve(),
};
