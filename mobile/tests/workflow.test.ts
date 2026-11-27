import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import test from 'node:test';
import { observeSession } from '../src/auth-state';
import type { AuthState } from '../src/auth-state';
import { createLynxrClient, readOnlyTransport } from '../src/client';
import { entries, scriptSections, statusLabel } from '../src/contracts';
import type { CreatorData, CreatorRow } from '../src/contracts';
import { creatorApi } from '../src/creator-api';
import { libraryStore } from '../src/library-store';
import { sessionStorage } from '../src/session-storage';

const endpoint = 'https://lynxr-mobile-test.invalid';
const publicKey = 'sb_publishable_test_fixture';
const creatorA = '10000000-0000-4000-8000-000000000001';
const creatorB = '10000000-0000-4000-8000-000000000002';
const emailA = 'one@example.invalid';
const emailB = 'two@example.invalid';
const password = 'fixture-password';
const json = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { 'X-Supabase-Api-Version': '2024-01-01' },
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function memory() {
  const items = new Map<string, string>();
  return { items, getItem: async (key: string) => items.get(key) ?? null,
    setItem: async (key: string, value: string) => { items.set(key, value); },
    removeItem: async (key: string) => { items.delete(key); } };
}

function simulate() {
  const values = memory();
  const keys = memory();
  // Native AES-GCM and SecureStore are replaced by Node crypto and memory.
  const makeStorage = () => sessionStorage(values, keys, {
    generateKey: async () => randomBytes(32).toString('hex'),
    async encrypt(value, secret) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', Buffer.from(secret, 'hex'), nonce);
      return Buffer.concat([nonce, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
    },
    async decrypt(value, secret) {
      const bytes = Buffer.from(value, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', Buffer.from(secret, 'hex'), bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
    },
  });
  const rows = new Map<string, CreatorRow>([
    [creatorA, { id: creatorA, updated_at: '2026-11-20T15:00:00Z',
      data: { name: 'Fixture one', adaptations: [{ id: 'one', title: 'Account one script', status: 'done',
        source: { script: { segments: [[0, 2, 'A synthetic spoken line']] },
          shots: [{ visual: 'A synthetic wide shot', onscreen_text: 'Fixture title' }] } }] } }],
    [creatorB, { id: creatorB, updated_at: '2026-11-20T15:00:00Z',
      data: { name: 'Fixture two', adaptations: [{ id: 'two', title: 'Account two script', status: 'done',
        brandId: 'brand', adaptation: { hook: 'Fixture hook', beats: [{ say: 'Saved edit', do: 'Lift the box', show: 'Title' }],
          cta: 'Read more', caption: 'Saved caption' } }] } }],
  ]);
  const events: { path: string; method: string }[] = [];
  const controls: { readFail?: boolean; misdirect?: boolean; readWait?: Promise<void>; refreshFail?: boolean } = {};
  let sessionCount = 0;
  const users = new Map([[emailA, creatorA], [emailB, creatorB]]);
  const sessions = new Map<string, string>();
  const sessionFor = (id: string) => {
    const token = 'fixture-access-' + ++sessionCount;
    const refresh = 'fixture-refresh-' + sessionCount;
    sessions.set(token, id);
    sessions.set(refresh, id);
    return { access_token: token, refresh_token: refresh, token_type: 'bearer', expires_in: 3600,
      user: { id, email: id === creatorA ? emailA : emailB, aud: 'authenticated', role: 'authenticated',
        app_metadata: { provider: 'email' }, user_metadata: { display_name: 'Créateur ' + '🙂'.repeat(1800) },
        created_at: '2026-11-20T15:00:00Z' } };
  };
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, endpoint, 'All test requests stay on the reserved fixture host');
    assert.equal(request.headers.get('apikey'), publicKey);
    events.push({ path: url.pathname, method: request.method });
    if (url.pathname === '/auth/v1/token') {
      const args = await request.json();
      if (url.searchParams.get('grant_type') === 'refresh_token') {
        if (controls.refreshFail) return json({ code: 'refresh_token_not_found', message: 'Refresh token expired' }, 400);
        const id = sessions.get(args.refresh_token);
        assert.ok(id, 'Refresh token belongs to a synthetic session');
        return json(sessionFor(id));
      }
      assert.equal(url.searchParams.get('grant_type'), 'password');
      const id = users.get(args.email);
      return id && args.password === password
        ? json(sessionFor(id)) : json({ code: 'invalid_credentials', message: 'Invalid credentials' }, 400);
    }
    if (url.pathname === '/auth/v1/logout') {
      assert.equal(url.searchParams.get('scope'), 'local');
      return new Response(null, { status: 204 });
    }
    assert.equal(url.pathname, '/rest/v1/lynxr_creators');
    assert.equal(request.method, 'GET', 'Any Data API mutation fails the test immediately');
    const id = url.searchParams.get('id')?.slice(3);
    assert.ok(id && url.searchParams.get('id')?.startsWith('eq.'));
    const token = request.headers.get('authorization')?.replace(/^Bearer /, '');
    const actor = token && sessions.get(token);
    await controls.readWait;
    if (controls.readFail) return json({ code: '42501', message: 'Fixture read denied' }, 403);
    const row = id === actor ? rows.get(id) : undefined;
    return json(controls.misdirect ? [rows.get(creatorB)] : row ? [row] : []);
  };
  async function newClient() {
    const client = createLynxrClient(endpoint, publicKey, makeStorage(), fakeFetch);
    await client.auth.stopAutoRefresh();
    return client;
  }
  async function signIn(email = emailA) {
    const client = await newClient();
    assert.ifError((await client.auth.signInWithPassword({ email, password })).error);
    return { client, api: creatorApi(client, users.get(email)!) };
  }
  return { newClient, signIn, makeStorage, events, rows, values, keys, controls };
}

test('existing-account sign-in, original script list and detail use only authenticated GET', async () => {
  const m = simulate();
  const { api } = await m.signIn();
  const data = await api.read();
  assert.equal(data.name, 'Fixture one');
  assert.equal(statusLabel(entries(data)[0]), 'Completed');
  assert.deepEqual(scriptSections(entries(data)[0]), [
    { title: 'What they say', lines: ['A synthetic spoken line'] },
    { title: 'What’s on screen', lines: ['A synthetic wide shot', 'Text: Fixture title'] },
  ]);
  assert.deepEqual(m.events, [
    { path: '/auth/v1/token', method: 'POST' },
    { path: '/rest/v1/lynxr_creators', method: 'GET' },
  ]);
});

test('existing brand scripts display saved edits and never include trash', async () => {
  const m = simulate();
  m.rows.get(creatorB)!.data.trash = [{ id: 'deleted', status: 'done' }];
  const { api } = await m.signIn(emailB);
  const jobs = entries(await api.read());
  assert.deepEqual(jobs.map((job) => job.id), ['two']);
  assert.deepEqual(scriptSections(jobs[0]), [
    { title: 'Hook', lines: ['Fixture hook'] },
    { title: 'Beat 1', lines: ['Saved edit', 'Do: Lift the box', 'On screen: Title'] },
    { title: 'Call to action', lines: ['Read more'] },
    { title: 'Caption', lines: ['Saved caption'] },
  ]);
});

test('invalid sign-in and signed-out reads fail without creator requests', async () => {
  const m = simulate();
  const client = await m.newClient();
  const fail = await client.auth.signInWithPassword({ email: emailA, password: 'wrong' });
  assert.equal(fail.error?.code, 'invalid_credentials');
  assert.equal(m.values.items.size, 0);
  await assert.rejects(creatorApi(client, creatorA).read(), /sign in again/i);
  assert.equal(m.events.filter(({ path }) => path.startsWith('/rest/')).length, 0);
});

test('large Unicode sessions persist as ciphertext, restore after restart, then clear on sign-out', async () => {
  const m = simulate();
  const { client } = await m.signIn();
  const session = (await client.auth.getSession()).data.session!;
  assert.ok(JSON.stringify(session).length > 2048);
  for (const value of m.values.items.values()) {
    assert.ok(!value.includes(session.access_token));
    assert.ok(!value.includes(emailA));
    assert.ok(!value.includes(password));
  }
  const restarted = await m.newClient();
  assert.equal((await restarted.auth.getSession()).data.session?.user.id, creatorA);
  assert.equal(m.events.length, 1, 'No sign-in request on restored unexpired session');
  assert.ifError((await restarted.auth.signOut({ scope: 'local' })).error);
  assert.equal(m.keys.items.size, 0);
  assert.equal(m.values.items.size, 0);
  assert.equal((await (await m.newClient()).auth.getSession()).data.session, null);
});

test('expired saved sessions refresh with the existing refresh token', async () => {
  const m = simulate();
  const { client } = await m.signIn();
  const saved = (await client.auth.getSession()).data.session!;
  await m.makeStorage().setItem('sb-lynxr-mobile-test-auth-token',
    JSON.stringify({ ...saved, expires_at: Math.floor(Date.now() / 1000) - 5 }));
  const restarted = await m.newClient();
  const session = (await restarted.auth.getSession()).data.session!;
  assert.equal(session.user.id, creatorA);
  assert.notEqual(session.access_token, saved.access_token);
  assert.equal(m.events.filter(({ path }) => path === '/auth/v1/token').length, 2);
});

test('missing device keys and damaged ciphertext cannot restore sessions', async () => {
  for (const damage of ['key', 'ciphertext']) {
    const m = simulate();
    await m.signIn();
    if (damage === 'key') m.keys.items.clear();
    else for (const key of m.values.items.keys()) m.values.items.set(key, 'broken');
    assert.equal((await (await m.newClient()).auth.getSession()).data.session, null);
  }
});

test('sign-out, account switching and an old account API never leak records', async () => {
  const m = simulate();
  const { client, api } = await m.signIn();
  assert.equal(entries(await api.read())[0].id, 'one');
  assert.ifError((await client.auth.signOut({ scope: 'local' })).error);
  await assert.rejects(api.read(), /sign in again/i);
  assert.ifError((await client.auth.signInWithPassword({ email: emailB, password })).error);
  await assert.rejects(api.read(), /sign in again/i);
  const next = await creatorApi(client, creatorB).read();
  assert.deepEqual(entries(next).map(({ id }) => id), ['two']);
});

test('a read in flight at account switch is discarded', async () => {
  const m = simulate();
  const { client, api } = await m.signIn();
  let finish!: () => void;
  m.controls.readWait = new Promise<void>((resolve) => { finish = resolve; });
  const pending = api.read();
  await tick();
  assert.ifError((await client.auth.signOut({ scope: 'local' })).error);
  assert.ifError((await client.auth.signInWithPassword({ email: emailB, password })).error);
  finish();
  await assert.rejects(pending, /account changed/i);
});

test('missing rows render an empty library; denial and mismatched returned owner fail closed', async () => {
  const m = simulate();
  const { api } = await m.signIn();
  m.rows.delete(creatorA);
  assert.deepEqual(await api.read(), {});
  m.controls.readFail = true;
  await assert.rejects(api.read(), /couldn’t load/i);
  m.controls.readFail = false;
  m.controls.misdirect = true;
  await assert.rejects(api.read(), /couldn’t load/i);
});

test('the transport blocks creator writes, RPCs, other tables, signup, and foreign hosts before fetch', async () => {
  let calls = 0;
  const request = readOnlyTransport(endpoint, async () => { calls++; return json([]); });
  for (const [path, method] of [
    ['/rest/v1/lynxr_creators', 'POST'], ['/rest/v1/lynxr_creators', 'PATCH'],
    ['/rest/v1/lynxr_creators', 'DELETE'], ['/rest/v1/rpc/my_allowance', 'POST'],
    ['/rest/v1/lynxr_clients', 'GET'], ['/auth/v1/signup', 'POST'],
    ['/auth/v1/user', 'PUT'], ['/functions/v1/billing-checkout', 'POST'],
  ]) await assert.rejects(request(endpoint + path, { method }), /only supports/i);
  await assert.rejects(request('https://other.invalid/rest/v1/lynxr_creators'), /only supports/i);
  assert.equal(calls, 0);
});

test('library state ignores stale refresh results and can restart after effect cleanup', async () => {
  const requests: ((data: CreatorData) => void)[] = [];
  const store = libraryStore(() => new Promise((resolve) => requests.push(resolve)));
  const first = store.refresh();
  const newer = store.refresh();
  requests[1]({ name: 'Newer' });
  await newer;
  requests[0]({ name: 'Older' });
  await first;
  assert.equal(store.getSnapshot().data?.name, 'Newer');

  const stale = store.refresh();
  store.deactivate();
  requests[2]({ name: 'Old account' });
  await stale;
  assert.equal(store.getSnapshot().data, undefined);
  store.activate();
  const fresh = store.refresh();
  requests[3]({ name: 'Current account' });
  await fresh;
  assert.equal(store.getSnapshot().data?.name, 'Current account');
});

test('library refresh errors preserve only this account’s last snapshot and allow retry', async () => {
  let fail = false;
  const store = libraryStore(async () => {
    if (fail) throw new Error('Synthetic denied');
    return { name: 'Fixture' };
  });
  await store.refresh();
  fail = true;
  await store.refresh();
  assert.equal(store.getSnapshot().data?.name, 'Fixture');
  assert.match(store.getSnapshot().error!, /couldn’t refresh/i);
  fail = false;
  await store.refresh();
  assert.equal(store.getSnapshot().error, null);
});

test('auth startup storage failure is recoverable without exposing underlying errors', async () => {
  const storage = sessionStorage({
    getItem: async () => { throw new Error('private synthetic detail'); },
    setItem: async () => {}, removeItem: async () => {},
  }, memory(), {
    generateKey: async () => 'unused',
    encrypt: async () => 'unused', decrypt: async () => 'unused',
  });
  const client = createLynxrClient(endpoint, publicKey, storage,
    async () => { throw new Error('No HTTP permitted'); });
  await client.auth.stopAutoRefresh();
  const states: AuthState[] = [];
  const stop = observeSession(client.auth, (state) => states.push(state), storage.hasIssue);
  await tick();
  await tick();
  assert.equal(states.at(-1)?.ready, true);
  assert.match(states.at(-1)?.error ?? '', /saved session/);
  assert.ok(!JSON.stringify(states).includes('private synthetic detail'));
  stop();
  await client.auth.stopAutoRefresh();
});

test('auth observer ignores late bootstrap after cleanup or a newer account event', async () => {
  const m = simulate();
  const { client } = await m.signIn();
  const previous = await client.auth.getSession();
  let resolve!: (value: typeof previous) => void;
  const bootstrap = new Promise<typeof previous>((done) => { resolve = done; });
  const delayedAuth = {
    getSession: () => bootstrap,
    onAuthStateChange: client.auth.onAuthStateChange.bind(client.auth),
  };
  const states: AuthState[] = [];
  const stop = observeSession(delayedAuth, (state) => states.push(state));
  assert.ifError((await client.auth.signInWithPassword({ email: emailB, password })).error);
  resolve(previous);
  await tick();
  assert.equal(states.at(-1)?.session?.user.id, creatorB);
  stop();

  let finish!: (value: typeof previous) => void;
  const pending = new Promise<typeof previous>((done) => { finish = done; });
  const stoppedStates: AuthState[] = [];
  const unsubscribe = observeSession({ ...delayedAuth, getSession: () => pending },
    (state) => stoppedStates.push(state));
  unsubscribe();
  finish(previous);
  await tick();
  assert.deepEqual(stoppedStates, []);
});

test('an expired revoked refresh token clears the session and cannot read the library', async () => {
  const m = simulate();
  const { client } = await m.signIn();
  const saved = (await client.auth.getSession()).data.session!;
  await m.makeStorage().setItem('sb-lynxr-mobile-test-auth-token',
    JSON.stringify({ ...saved, expires_at: Math.floor(Date.now() / 1000) - 5 }));
  m.controls.refreshFail = true;
  const restarted = await m.newClient();
  assert.equal((await restarted.auth.getSession()).data.session, null);
  await assert.rejects(creatorApi(restarted, creatorA).read(), /sign in again/i);
  assert.equal(m.events.some(({ path }) => path.startsWith('/rest/')), false);
});
