import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { PermissionOverwrites,OverwriteType } from 'discord.js';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { AgentStore } from '../src/agent-bridge/store.js';
import { AgentBridge,secretMatches,splitReply } from '../src/agent-bridge/index.js';
import { buildInvocation,parseAgentEvent,downloadAttachments,runAgent } from '../agent-runner/agents.js';

test('authentication rejects missing/short/mismatched secrets',()=>{
  const secret='a'.repeat(64);
  assert.equal(secretMatches(`Bearer ${secret}`,secret),true);
  for(const value of [undefined,'',secret,`Bearer ${'b'.repeat(64)}`]) assert.equal(secretMatches(value,secret),false);
  assert.equal(secretMatches('Bearer short','short'),false);
});
test('responses split under Discord limits without dropping text',()=>{
  const text=('hello\n'.repeat(2000))+'終わり';
  const chunks=splitReply(text);
  assert.equal(chunks.join(''),text); assert.ok(chunks.every(c=>c.length<=1850));
});
test('agent prompts use argv/stdin and never bypass native permissions',()=>{
  for(const agent of ['claude','codex']) {
    const first=buildInvocation(agent,null,{});
    const resumed=buildInvocation(agent,'saved-session',{});
    assert.ok(resumed.args.includes('saved-session'));
    assert.ok(!first.args.some(a=>a.startsWith('--')&&/bypass|dangerously/.test(a)));
  }
  assert.throws(()=>buildInvocation('sh',null,{}));
});
test('native event parsing keeps real session IDs and errors',()=>{
  assert.deepEqual(parseAgentEvent('codex',{type:'thread.started',thread_id:'c1'}),{sessionId:'c1'});
  assert.equal(parseAgentEvent('claude',{type:'result',session_id:'s1',is_error:true,result:'permission denied'}).error,'permission denied');
});
test('attachments cannot turn the runner into an arbitrary URL fetcher',async()=>{
  for(const url of ['http://127.0.0.1/admin','https://example.com/a','https://cdn.discordapp.com.evil.test/a'])
    await assert.rejects(downloadAttachments([{url}],'/tmp','test'),/Discord CDN/);
});
test('stop cancels the native process and retains the resume session',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'renbot-cancel-'));
  try {
    const binary=path.join(dir,'fake-agent');
    await writeFile(binary,`#!${process.execPath}\nconsole.log(JSON.stringify({type:'thread.started',thread_id:'saved-thread'}));setInterval(()=>{},1000);`,{mode:0o700});
    const controller=new AbortController();
    const result=await runAgent({agent:'codex',conversation:'test',attachments:[],prompt:'test'},
      {workspace:dir,codexBin:binary,taskTimeoutMs:10000},
      {signal:controller.signal,onSession:async()=>controller.abort()});
    assert.equal(result.failed,true);assert.equal(result.sessionId,'saved-thread');assert.match(result.result,/stopped/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
test('owner allowlist rejects other users before touching the queue',async()=>{
  const bridge=new AgentBridge({},{},{AGENT_BRIDGE_GUILD_ID:'1568326446294896640',AGENT_BRIDGE_SECRET:'s'.repeat(64)});
  bridge.ownerId='111111111111111111'; bridge.channels.set('channel','codex');
  const message={author:{id:'222222222222222222',bot:false},guild:{id:bridge.guildId},channel:{id:'channel'}};
  assert.equal(await bridge.handleMessage(message),true);
  assert.equal(await bridge.handleMessage({...message,guild:null}),false);
  assert.equal(await bridge.handleMessage({...message,guild:{id:'999999999999999999'}}),false);
});
test('private channel permissions resolve even when the owner is not cached',async()=>{
  const created=[];
  const guild={id:'1568326446294896640',ownerId:'1251033797336629271',roles:{cache:new Map()},members:{cache:new Map()},channels:{
    fetch:async()=>({find:()=>undefined}),
    create:async spec=>{created.push(spec);return {id:spec.name,send:async()=>{}};},
  }};
  const client={user:{id:'1568326223996920080'},guilds:{fetch:async()=>guild}};
  const bridge=new AgentBridge(client,{},{AGENT_BRIDGE_GUILD_ID:guild.id,AGENT_BRIDGE_SECRET:'s'.repeat(64)});
  try {
    await bridge.bootstrap();
    assert.equal(created.length,2);
    for(const spec of created) {
      assert.equal(spec.permissionOverwrites[0].type,OverwriteType.Role);
      for(const overwrite of spec.permissionOverwrites)assert.doesNotThrow(()=>PermissionOverwrites.resolve(overwrite,guild));
    }
  } finally {bridge.close();}
});
test('HTTP bridge refuses unauthenticated and malformed worker requests',async()=>{
  const bridge=new AgentBridge({},{},{AGENT_BRIDGE_GUILD_ID:'1568326446294896640',AGENT_BRIDGE_SECRET:'s'.repeat(64)});
  const app=express(); app.use('/agent-bridge',bridge.router());
  const server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
  const url=`http://127.0.0.1:${server.address().port}/agent-bridge/claim`;
  try {
    assert.equal((await fetch(url,{method:'POST'})).status,401);
    assert.equal((await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${'s'.repeat(64)}`,'Content-Type':'application/json'},body:'{}'})).status,400);
  } finally {await new Promise(r=>server.close(r));}
});
test('durable PostgreSQL queue: dedupe, serial claim, ownership, cancellation, expiry, and idempotent completion',async()=>{
  const db=new PGlite();
  const pool={
    async query(sql,params){
      if(sql.includes('pg_advisory_xact_lock'))return {rows:[],rowCount:0};
      if(!params&&sql.includes('CREATE TABLE')){await db.exec(sql);return {rows:[],rowCount:0};}
      const result=await db.query(sql,params);return {...result,rowCount:/^\s*SELECT/i.test(sql)?result.rows.length:(result.affectedRows??result.rows.length)};
    },
    async connect(){return {...this,release(){}};},
  };
  const store=new AgentStore(pool);
  try {
    await store.initialize();
    const conv=await store.conversation('owner-channel','codex');
    assert.equal((await store.conversation('owner-channel','codex')).generation,conv.generation);
    assert.notEqual((await store.conversation('owner-channel','codex',true)).generation,conv.generation);
    const job={messageId:'m1',channelId:'channel',ownerId:'owner',conversation:conv.generation,agent:'codex',prompt:'hello',attachments:[]};
    const first=await store.enqueue(job); assert.ok(first);
    assert.equal(await store.enqueue(job),undefined);
    const second=await store.enqueue({...job,messageId:'m2'});
    const claim=await store.claim('mac'); assert.equal(claim.id,first.id);
    assert.equal(await store.claim('other-worker'),null);
    assert.equal(await store.heartbeat(first.id,'other-worker'),undefined);
    assert.equal(await store.complete(first.id,'other-worker','bad',false),undefined);
    await store.cancel('channel','owner');
    assert.equal((await store.heartbeat(first.id,'mac')).cancel_requested,true);
    assert.equal((await store.complete(first.id,'mac','done',false)).status,'completed');
    assert.equal((await store.complete(first.id,'mac','duplicate',false)).result,'done');
    assert.equal(await store.claim('mac'),null);
    assert.equal((await store.undelivered()).length,1);
    await store.delivered(first.id,['reply']); assert.equal((await store.undelivered()).length,0);
    await store.enqueue({...job,messageId:'m3'});
    await pool.query(`UPDATE renbot_agent_jobs SET created_at=NOW()-INTERVAL '40 minutes' WHERE message_id='m3'`);
    assert.equal(await store.claim('mac'),null);
    assert.equal((await store.undelivered())[0].status,'failed');
    await store.enqueue({...job,messageId:'m4'}); const running=await store.claim('mac');
    await pool.query(`UPDATE renbot_agent_jobs SET heartbeat_at=NOW()-INTERVAL '3 minutes' WHERE id=$1`,[running.id]);
    assert.equal(await store.claim('mac'),null);
    assert.equal((await pool.query('SELECT status FROM renbot_agent_jobs WHERE id=$1',[running.id])).rows[0].status,'failed');
  } finally {await db.close();}
});
