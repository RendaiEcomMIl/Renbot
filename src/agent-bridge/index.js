import { createHash,timingSafeEqual } from 'node:crypto';
import express from 'express';
import { ChannelType,PermissionFlagsBits,OverwriteType } from 'discord.js';
import { AgentStore } from './store.js';
import { ensureServerLayout } from './layout.js';

export function secretMatches(value,secret) {
  if (!secret || secret.length<40 || typeof value!=='string') return false;
  const hash=s=>createHash('sha256').update(s).digest();
  return timingSafeEqual(hash(value),hash(`Bearer ${secret}`));
}
export function splitReply(text,size=1850) {
  const chunks=[]; let rest=String(text||'(The agent finished without a text response.)');
  while(rest.length>size) {
    let cut=rest.lastIndexOf('\n',size); if(cut<size/2) cut=size;
    chunks.push(rest.slice(0,cut)); rest=rest.slice(cut);
  }
  if(rest) chunks.push(rest); return chunks;
}

export class AgentBridge {
  constructor(client,pool,env=process.env) {
    this.client=client; this.store=new AgentStore(pool);
    this.guildId=env.AGENT_BRIDGE_GUILD_ID; this.secret=env.AGENT_BRIDGE_SECRET;
    if(!/^\d{17,20}$/.test(this.guildId||'')||(this.secret||'').length<40)
      throw new Error('Agent bridge needs a guild ID and a secret of at least 40 characters.');
    this.channels=new Map(); this.ownerId=null; this.deliveryBusy=false;
    // Bot-to-bot: channels where the Mac may post as Renbot and read replies (e.g. talking to yutbot).
    this.peerChannels=new Set((env.AGENT_BRIDGE_PEER_CHANNELS||'').split(',').map(s=>s.trim()).filter(s=>/^\d{17,20}$/.test(s)));
  }
  async peerChannel(id) {
    if(typeof id!=='string'||!this.peerChannels.has(id)) return null;
    const channel=await this.client.channels.fetch(id).catch(()=>null);
    return channel?.isTextBased()?channel:null;
  }
  async initialize() { await this.store.initialize(); }
  async bootstrap() {
    const guild=await this.client.guilds.fetch(this.guildId);
    this.ownerId=guild.ownerId;
    const channels=await guild.channels.fetch();
    for(const agent of ['claude','codex']) {
      let channel=channels.find(c=>c?.name===agent&&c.type===ChannelType.GuildText);
      const permissionOverwrites=[
        {id:guild.id,type:OverwriteType.Role,deny:[PermissionFlagsBits.ViewChannel]},
        {id:this.ownerId,type:OverwriteType.Member,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.AttachFiles,PermissionFlagsBits.CreatePublicThreads,PermissionFlagsBits.SendMessagesInThreads]},
        {id:this.client.user.id,type:OverwriteType.Member,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.AttachFiles,PermissionFlagsBits.SendMessagesInThreads,PermissionFlagsBits.ManageThreads]},
      ];
      if(!channel) {
        channel=await guild.channels.create({name:agent,type:ChannelType.GuildText,permissionOverwrites,
          topic:`Chat with ${agent==='claude'?'Claude Code':'Codex'} on your Mac. Owner only. !new starts fresh; !stop cancels; !status checks the Mac. Threads have separate conversations.`});
        await channel.send({content:`**${agent==='claude'?'Claude Code':'Codex'} is ready here.**\nSend a normal message to start. Follow-ups keep the same conversation. Open a thread for a separate task.\n\n\`!new\` — start a new conversation\n\`!stop\` — stop the current task\n\`!status\` — check the Mac runner\n\`!help\` — show these controls\n\nYour Mac must be awake and online.`,allowedMentions:{parse:[]}});
      } else await channel.permissionOverwrites.set(permissionOverwrites);
      this.channels.set(channel.id,agent);
    }
    this.layout=await ensureServerLayout(guild,this.ownerId,this.client.user.id);
    this.channels.set(this.layout.tasks.id,'codex');
    // Private #yutbot channel for bot-to-bot chat. Permissions are only set on creation so manual adds (yutbot) survive restarts.
    let peer=channels.find(c=>c?.name==='yutbot'&&c.type===ChannelType.GuildText);
    if(!peer) peer=await guild.channels.create({name:'yutbot',type:ChannelType.GuildText,topic:'Renbot ↔ yutbot. The Mac posts here as Renbot and reads the replies.',
      permissionOverwrites:[
        {id:guild.id,type:OverwriteType.Role,deny:[PermissionFlagsBits.ViewChannel]},
        {id:this.ownerId,type:OverwriteType.Member,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory]},
        {id:this.client.user.id,type:OverwriteType.Member,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory]},
      ]});
    this.peerChannels.add(peer.id);
    await this.updateDashboard();
    this.timer=setInterval(()=>this.deliver().catch(()=>{}),4000); this.timer.unref();
    this.dashboardTimer=setInterval(()=>this.updateDashboard().catch(()=>{}),15000); this.dashboardTimer.unref();
  }
  async handleMessage(message) {
    if(message.author.bot||!this.ownerId) return false;
    const key=`${message.channel.id}:${message.author.id}`;
    let agent;
    if(!message.guild) {
      if(message.author.id!==this.ownerId) return false;
      const selected=message.content.match(/^!(claude|codex)(?:\s|$)/i)?.[1]?.toLowerCase();
      agent=selected||await this.store.agent(key)||'codex';
      if(message.content.startsWith('!')&&!/^!(claude|codex|new|stop|status|help)(?:\s|$)/i.test(message.content)) return false;
    } else {
      if(message.guild.id!==this.guildId) return false;
      agent=this.channels.get(message.channel.id)||this.channels.get(message.channel.parentId);
      if(!agent) return false;
      if(message.author.id!==this.ownerId) return true;
    }
    const send=content=>message.reply({content,allowedMentions:{parse:[],repliedUser:false}});
    const text=message.content.trim();
    if(/^!help$/i.test(text)) {
      await send('Chat normally here. Follow-ups keep context. `!new` starts fresh; `!stop` cancels; `!status` checks the Mac. Threads keep separate conversations. In DMs, `!claude <message>` or `!codex <message>` selects an agent.'); return true;
    }
    if(/^!status$/i.test(text)) {
      const s=await this.store.status();
      await send(`Mac runner: **${s.workerOnline?'online':'offline'}**. ${s.jobs.map(j=>`${j.count} ${j.status}`).join(', ')||'No tasks waiting.'}`); return true;
    }
    if(/^!stop$/i.test(text)) {
      const count=await this.store.cancel(message.channel.id,message.author.id);
      await send(count?'Stop requested. Changes the agent already made remain.':'No tasks are running in this conversation.'); return true;
    }
    if(/^!new$/i.test(text)) {
      await this.store.cancel(message.channel.id,message.author.id);
      await this.store.conversation(key,agent,true);
      await send('Started a fresh conversation. Send your next message whenever you’re ready.'); return true;
    }
    const prompt=text.replace(/^!(claude|codex)(?:\s+|$)/i,'');
    if(!prompt&&!message.attachments.size) { await this.store.conversation(key,agent); await send(`Now using ${agent}. Send your message.`); return true; }
    if(prompt.length>18000) { await send('Please split this request into shorter messages.'); return true; }
    const conversation=await this.store.conversation(key,agent);
    const attachments=[...message.attachments.values()].slice(0,4).map(a=>({url:a.url,name:a.name,size:a.size,contentType:a.contentType}));
    const job=await this.store.enqueue({messageId:message.id,channelId:message.channel.id,ownerId:this.ownerId,
      conversation:conversation.generation,agent,prompt,attachments});
    if(!job) { await send('The queue is full or this message is already queued. Use `!status` to check.'); return true; }
    await message.react('👀').catch(()=>{});
    if(!(await this.store.status()).workerOnline) await send('Queued. Your Mac runner is offline; I’ll pick this up when it reconnects. Messages expire after 30 minutes.');
    return true;
  }
  router() {
    const router=express.Router();
    router.use((req,res,next)=>{
      if(!secretMatches(req.headers.authorization,this.secret)) return res.sendStatus(401);
      res.set('Cache-Control','no-store'); next();
    });
    router.use(express.json({limit:'512kb'}));
    const worker=req=>typeof req.body?.workerId==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(req.body.workerId)?req.body.workerId:null;
    router.post('/claim',async(req,res)=>{
      const id=worker(req); if(!id) return res.sendStatus(400);
      await this.store.workerSeen(id);
      if(!this.ownerId) return res.status(503).json({error:'Discord not ready'});
      const job=await this.store.claim(id);
      if(job&&job.owner_id!==this.ownerId) return res.sendStatus(403);
      res.json({job,ownerId:this.ownerId});
    });
    router.post('/heartbeat',async(req,res)=>{
      const id=worker(req); if(!id||typeof req.body.jobId!=='string') return res.sendStatus(400);
      await this.store.workerSeen(id);
      const job=await this.store.heartbeat(req.body.jobId,id);
      if(!job) return res.status(409).json({cancel:true});
      const channel=await this.client.channels.fetch(job.channel_id).catch(()=>null);
      if(channel?.isTextBased()) channel.sendTyping().catch(()=>{});
      res.json({cancel:job.cancel_requested});
    });
    router.post('/complete',async(req,res)=>{
      const id=worker(req);
      if(!id||typeof req.body.jobId!=='string'||typeof req.body.result!=='string') return res.sendStatus(400);
      const job=await this.store.complete(req.body.jobId,id,req.body.result.slice(0,60000),req.body.failed===true);
      if(!job) return res.sendStatus(409);
      res.json({accepted:true}); this.deliver().catch(()=>{});
    });
    router.post('/say',async(req,res)=>{
      const {channelId,text,mentionUserId}=req.body||{};
      if(typeof text!=='string'||!text.trim()||text.length>1900) return res.sendStatus(400);
      if(mentionUserId!==undefined&&!/^\d{17,20}$/.test(String(mentionUserId))) return res.sendStatus(400);
      const channel=await this.peerChannel(channelId); if(!channel) return res.sendStatus(403);
      const content=mentionUserId?`<@${mentionUserId}> ${text}`:text;
      const sent=await channel.send({content,allowedMentions:{users:mentionUserId?[String(mentionUserId)]:[],parse:[]}});
      res.json({messageId:sent.id});
    });
    router.post('/read',async(req,res)=>{
      const {channelId,after}=req.body||{};
      if(after!==undefined&&!/^\d{17,20}$/.test(String(after))) return res.sendStatus(400);
      const channel=await this.peerChannel(channelId); if(!channel) return res.sendStatus(403);
      const limit=Math.min(Math.max(Number(req.body.limit)||20,1),50);
      const fetched=await channel.messages.fetch(after?{after:String(after),limit}:{limit});
      res.json({messages:[...fetched.values()].sort((a,b)=>a.createdTimestamp-b.createdTimestamp).map(m=>({
        id:m.id,authorId:m.author.id,author:m.author.username,bot:m.author.bot,at:m.createdAt.toISOString(),
        content:m.content,attachments:[...m.attachments.values()].map(a=>({name:a.name,url:a.url}))}))});
    });
    router.use((error,req,res,next)=>{if(!res.headersSent) res.status(503).json({error:'Bridge temporarily unavailable'});});
    return router;
  }
  async deliver() {
    if(this.deliveryBusy||!this.client.isReady()) return;
    this.deliveryBusy=true;
    try {
      for(const job of await this.store.undelivered()) {
        const channel=await this.client.channels.fetch(job.channel_id).catch(()=>null);
        if(!channel?.isTextBased()) continue;
        if(channel.guildId&&(channel.guildId!==this.guildId||!(this.channels.has(channel.id)||this.channels.has(channel.parentId)))) continue;
        if(job.owner_id!==this.ownerId) continue;
        const ids=[];
        for(const [i,content] of splitReply(job.result).entries()) {
          const sent=await channel.send({content,
            ...(i===0?{reply:{messageReference:job.message_id,failIfNotExists:false}}:{}),
            nonce:createHash('sha256').update(`${job.id}:${i}`).digest('hex').slice(0,24),enforceNonce:true,
            allowedMentions:{parse:[],repliedUser:false}});
          ids.push(sent.id);
        }
        await this.store.delivered(job.id,ids);
        if(job.status==='failed'&&this.layout?.alerts) {
          await this.layout.alerts.send({content:`⚠️ **${job.agent==='claude'?'Claude Code':'Codex'} task needs attention.**\nSee the response: https://discord.com/channels/${this.guildId}/${job.channel_id}/${ids[0]}`,allowedMentions:{parse:[]}}).catch(()=>{});
        }
        const original=await channel.messages.fetch(job.message_id).catch(()=>null);
        await original?.react(job.status==='failed'?'⚠️':'✅').catch(()=>{});
      }
    } finally {this.deliveryBusy=false;}
  }
  async updateDashboard() {
    if(this.dashboardBusy||!this.layout?.status)return;
    this.dashboardBusy=true;
    try {
      const status=await this.store.status();
      const content=`**Renbot status**\n\nDiscord bot: 🟢 Online\nMac runner: ${status.workerOnline?'🟢 Online':'🔴 Offline'}\nQueue: ${status.jobs.map(j=>`${j.count} ${j.status}`).join(', ')||'No tasks waiting'}\n\nAgents: Claude Code + Codex\n\nChat in <#${[...this.channels].find(([,agent])=>agent==='claude')?.[0]}> or <#${[...this.channels].find(([,agent])=>agent==='codex')?.[0]}>. Create a task thread in <#${this.layout.tasks.id}>.\n\nYour Mac must be awake and online. Use \`!status\` in an agent conversation for a current check.`;
      if(content===this.lastDashboardContent)return;
      const key=`layout:${this.guildId}:dashboard`;
      const saved=await this.store.meta(key);
      let message=saved?.id?await this.layout.status.messages.fetch(saved.id).catch(()=>null):null;
      if(message) await message.edit({content,allowedMentions:{parse:[]}});
      else {
        message=await this.layout.status.send({content,allowedMentions:{parse:[]}});
        await message.pin().catch(()=>{});
        await this.store.setMeta(key,{id:message.id});
      }
      this.lastDashboardContent=content;
    } finally {this.dashboardBusy=false;}
  }
  close() {clearInterval(this.timer);clearInterval(this.dashboardTimer);}
}
