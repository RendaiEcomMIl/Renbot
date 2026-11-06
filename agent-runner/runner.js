import { readFile,mkdir,writeFile,unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadJson,saveJson,runAgent } from './agents.js';

const configFile=process.argv[2]||path.join(os.homedir(),'.config','renbot','runner.json');
const config=JSON.parse(await readFile(configFile,'utf8'));
const origin=new URL(config.relayUrl);
if(origin.protocol!=='https:'&&!(process.env.RENBOT_TEST_MODE==='true'&&origin.hostname==='127.0.0.1')) throw new Error('Relay URL must use HTTPS');
if(!/^\d{17,20}$/.test(config.ownerId||'')||(config.secret||'').length<40) throw new Error('Owner ID and bridge secret are required');
config.workerId ||= 'renbot-mac';
const stateDir=path.join(path.dirname(configFile),'state');
await mkdir(stateDir,{recursive:true,mode:0o700});
const lockFile=path.join(stateDir,'runner.pid');
try {
  const existing=Number(await readFile(lockFile,'utf8'));
  try {process.kill(existing,0);throw new Error('Another Renbot runner is already active');}
  catch(e){if(e.code!=='ESRCH')throw e;}
} catch(e){if(e.code!=='ENOENT')throw e;}
await writeFile(lockFile,String(process.pid),{mode:0o600});
const sessionsFile=path.join(stateDir,'sessions.json');
const pendingFile=path.join(stateDir,'pending-result.json');
const sessions=await loadJson(sessionsFile);
let stopping=false,activeController=null;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const log=message=>process.stdout.write(`${new Date().toISOString()} ${message}\n`);
const call=async(route,body)=>{
  const response=await fetch(new URL(`/agent-bridge/${route}`,origin),{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${config.secret}`},
    body:JSON.stringify({workerId:config.workerId,...body}),signal:AbortSignal.timeout(20000)});
  if(!response.ok) {const error=new Error(`Relay ${route}: HTTP ${response.status}`);error.status=response.status;throw error;}
  return response.json();
};
const stop=()=>{stopping=true;activeController?.abort();};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
log('Renbot runner started; waiting for owner messages.');
try {
  while(!stopping) {
    try {
      const pending=await loadJson(pendingFile,null);
      if(pending) {
        try {await call('complete',pending);}
        catch(e){if(e.status!==409)throw e;log('Previous result was no longer accepted; keeping its local audit copy.');}
        await saveJson(path.join(stateDir,`result-${pending.jobId}.json`),pending);
        await unlink(pendingFile);
      }
      const {job,ownerId}=await call('claim',{});
      if(!job){await sleep(3000);continue;}
      if(ownerId!==config.ownerId||job.owner_id!==config.ownerId) throw new Error('Relay owner does not match the locally approved owner');
      if(!['claude','codex'].includes(job.agent)||!/^[0-9a-f-]{36}$/.test(job.conversation)) throw new Error('Invalid task from relay');
      activeController=new AbortController();
      let heartbeatBusy=false,lastHeartbeat=Date.now(),progress='';
      const heartbeat=setInterval(async()=>{
        if(heartbeatBusy)return; heartbeatBusy=true;
        try {
          const response=await call('heartbeat',{jobId:job.id,progress});lastHeartbeat=Date.now();
          if(response.cancel)activeController?.abort();
        } catch(e){if(e.status===409||Date.now()-lastHeartbeat>75000)activeController?.abort();}
        finally {heartbeatBusy=false;}
      },10000);
      log(`Running ${job.agent} task ${job.id}`);
      let result;
      try {
        result=await runAgent(job,config,{
          signal:activeController.signal,sessionId:sessions[job.conversation]?.sessionId,
          onProgress:value=>{progress=value;},
          onSession:async sessionId=>{sessions[job.conversation]={agent:job.agent,sessionId};await saveJson(sessionsFile,sessions);},
        });
        if(result.sessionId){sessions[job.conversation]={agent:job.agent,sessionId:result.sessionId};await saveJson(sessionsFile,sessions);}
      } catch(e){result={failed:true,result:`The local agent could not run: ${e.message}`};}
      finally {clearInterval(heartbeat);activeController=null;}
      await saveJson(pendingFile,{jobId:job.id,result:result.result,failed:result.failed});
      log(`Finished ${job.agent} task ${job.id} (${result.failed?'needs attention':'completed'})`);
    } catch(e){log(`Waiting to reconnect: ${e.message}`);await sleep(5000);}
  }
} finally {await unlink(lockFile).catch(()=>{});log('Renbot runner stopped.');}
