// Talk to another bot (e.g. yutbot) as Renbot, through the relay's /say and /read routes.
//   node agent-runner/peer.js say  <channelId> "<text>" <botUserId>      (always sent as "@bot <text>")
//   node agent-runner/peer.js read <channelId> [afterMessageId] [limit]
//   node agent-runner/peer.js ask  <channelId> "<text>" <botUserId> [timeoutSec]   (say, then wait for that bot's reply)
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const config=JSON.parse(await readFile(process.env.RENBOT_CONFIG||path.join(os.homedir(),'.config','renbot','runner.json'),'utf8'));
const call=async(route,body)=>{
  const response=await fetch(new URL(`/agent-bridge/${route}`,config.relayUrl),{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.secret}`},
    body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  if(!response.ok) throw new Error(`Relay ${route}: HTTP ${response.status}${response.status===403?' (channel not in AGENT_BRIDGE_PEER_CHANNELS)':''}`);
  return response.json();
};
const print=messages=>{for(const m of messages) console.log(`[${m.at}] ${m.author}${m.bot?' (bot)':''} (id ${m.id}): ${m.content}${m.attachments.map(a=>` [file ${a.name}]`).join('')}`);};

const [cmd,channelId,...rest]=process.argv.slice(2);
// Operator rule: every message to the peer bot starts with its @mention.
if(['say','ask'].includes(cmd)&&!/^\d{17,20}$/.test(cmd==='say'?rest[1]||'':rest[1]||'')) {console.error('A bot user ID is required: messages must start with @yutbot.'); process.exit(1);}
if(cmd==='say') console.log(JSON.stringify(await call('say',{channelId,text:rest[0],mentionUserId:rest[1]})));
else if(cmd==='read') print((await call('read',{channelId,after:rest[0],limit:rest[1]})).messages);
else if(cmd==='ask') {
  const [text,botId,timeout='120']=rest;
  const {messageId}=await call('say',{channelId,text,mentionUserId:botId});
  const deadline=Date.now()+Number(timeout)*1000; let after=messageId, got=[];
  while(Date.now()<deadline) {
    await new Promise(r=>setTimeout(r,4000));
    const {messages}=await call('read',{channelId,after,limit:50});
    if(messages.length) after=messages.at(-1).id;
    got.push(...messages.filter(m=>m.authorId===botId));
    if(got.length) {await new Promise(r=>setTimeout(r,6000)); const more=await call('read',{channelId,after,limit:50}); got.push(...more.messages.filter(m=>m.authorId===botId)); break;}
  }
  if(got.length) print(got); else {console.error(`No reply from ${botId} within ${timeout}s.`); process.exit(2);}
}
else {console.error('usage: peer.js say|read|ask <channelId> ...'); process.exit(1);}
