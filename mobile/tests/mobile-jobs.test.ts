import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mobileTransport } from '../src/client';
import { submissionOutbox } from '../src/jobs';
import { videoUrl } from '../src/video-url';

test('supported URL shapes canonicalize while deceptive and unsupported hosts fail', () => {
  assert.equal(videoUrl('Watch https://instagram.com/reel/Ab_12/?igsh=x'), 'https://www.instagram.com/reel/Ab_12/');
  assert.equal(videoUrl('https://vt.tiktok.com/Abc123/'), 'https://vt.tiktok.com/Abc123/');
  assert.equal(videoUrl('https://www.tiktok.com/@creator.name/video/123?x=1'), 'https://www.tiktok.com/@creator.name/video/123');
  for(const u of ['https://instagram.com.evil.invalid/reel/x/', 'https://evil@instagram.com/reel/x/', 'http://instagram.com/reel/x/', 'https://instagram.com/user/', 'https://instagram.com:443/reel/a/ https://tiktok.com/@x/video/1', 'file:///x']) assert.throws(()=>videoUrl(u));
});

test('mobile transport permits only enumerated owner RPCs and rejects bypasses before fetch', async () => {
  const calls: string[]=[];
  const request=mobileTransport('https://mobile.invalid', async(input,init) => {
    assert.equal(init?.redirect,'error'); calls.push(String(input)); return new Response('{}');
  });
  await request('https://mobile.invalid/rest/v1/rpc/mobile_snapshot',{method:'POST'});
  for(const [path,method] of [
    ['/rest/v1/lynxr_creators','PATCH'], ['/rest/v1/rpc/charge_scripts','POST'],
    ['/rest/v1/rpc/mobile_claim_job','POST'], ['/rest/v1/rpc/mobile_submit_job?x=1','POST'],
    ['/rest/v1/rpc/mobile_snapshot/','POST'], ['/rest/v1/rpc/mobile_snapshot','GET'],
    ['/auth/v1/token?grant_type=password&grant_type=refresh_token','POST'], ['/auth/v1/token?grant_type=password&x=1','POST'],
    ['/auth/v1/signup','POST'], ['/auth/v1/logout?scope=global','POST'],
    ['/storage/v1/object/x','GET'], ['/rest/v1/lynxr_mobile_jobs','GET'],
  ]) await assert.rejects(request('https://mobile.invalid'+path,{method}));
  await assert.rejects(request('https://other.invalid/rest/v1/rpc/mobile_snapshot',{method:'POST'}));
  await assert.rejects(request('https://name:secret@mobile.invalid/rest/v1/rpc/mobile_snapshot',{method:'POST'}));
  assert.equal(calls.length,1);
});

test('outbox survives termination/lost response and refuses overwriting another request', async () => {
  const values=new Map<string,string>();
  const storage={async getItem(k:string){return values.get(k)??null;},async setItem(k:string,v:string){values.set(k,v);},async removeItem(k:string){values.delete(k);}};
  const a=submissionOutbox(storage,'a');
  const s={id:'stable-request-id',userId:'a',url:'https://instagram.com/reel/test/',brand:'',consent:true as const};
  await a.save(s);
  const restarted=submissionOutbox(storage,'a');
  assert.deepEqual(await restarted.load(),s);
  await restarted.save(s);
  await assert.rejects(restarted.save({...s,id:'new-id'}));
  assert.equal(await submissionOutbox(storage,'b').load(),null);
  await assert.rejects(submissionOutbox(storage,'b').save(s));
  await restarted.clear();assert.equal(await a.load(),null);
});

import { localTestHost } from '../src/environment';
test('internal HTTP configuration cannot turn a public endpoint into local testing',()=>{
  for(const host of ['127.0.0.1','localhost','10.1.2.3','192.168.1.3','172.16.0.4','172.31.255.255']) assert.equal(localTestHost(host),true);
  for(const host of ['8.8.8.8','172.32.0.1','192.169.1.1','10.evil.invalid','https://localhost','999.0.0.1']) assert.equal(localTestHost(host),false);
});
