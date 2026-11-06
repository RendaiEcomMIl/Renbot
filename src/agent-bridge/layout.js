import { ChannelType,OverwriteType,PermissionFlagsBits } from 'discord.js';

export const SERVER_LAYOUT = [
  { name:'🤖 Agents', channels:[
    {name:'claude',existingAgent:true},
    {name:'codex',existingAgent:true},
    {name:'🔁｜agent-tasks',key:'tasks',topic:'One thread per task. Codex responds in this channel and its threads. Track Pending → In progress → Waiting → Done.',
      guide:'**Agent tasks**\nCreate one thread per task so each task keeps its own conversation with Codex.\n\n**Task template**\n• Goal\n• Context or links\n• What “done” looks like\n• Due date in JST\n• State: Pending / In progress / Waiting / Done\n\nWrite the task inside its thread. Use `!stop` there to interrupt, `!new` to start fresh, and `!status` to check the Mac. Use the separate `#claude` channel for Claude Code.'},
  ]},
  { name:'📋 Operations',channels:[
    {name:'🤓｜reminders',topic:'Reminders and follow-ups. Keep a due date, next action and state on each item.',
      guide:'**Reminders & follow-ups**\nUse one thread per reminder.\n\n**Template:** What to remember • Due date/time (JST) • Next action • Pending / Done / Cancelled.\n\nFor a timed notification, include an explicit scheduling request in `#claude` or `#codex` and check the agent’s confirmation.'},
    {name:'📅｜events',topic:'Upcoming launches, meetings and deadlines. Record date/time in JST and the next action.',
      guide:'**Events & deadlines**\nUse one thread per event or launch.\n\n**Template:** Event • Date/time (JST) • Preparation checklist • Links • Pending / In progress / Done / Cancelled.'},
    {name:'🚨｜alerts',key:'alerts',topic:'Agent task failures and actionable operational alerts. Owner only.',
      guide:'**Actionable alerts**\nRenbot posts a link here when an agent task fails or is interrupted.\n\nFor other alerts, post: **Problem • Impact • Next action • Resolved/open**. External payment, email and advertising feeds can be connected separately.'},
  ]},
  { name:'🏪 Stores',channels:[
    {name:'🔵｜meta-ads',topic:'Advertising plans, experiment records and performance reviews.',
      guide:'**Meta ads**\nUse one thread per campaign, experiment or issue.\n\n**Template:** Store/campaign • Hypothesis • Variables changed • Budget/date • Result • Next decision.\n\nKeep account credentials out of posts. This channel is ready for your reports and requests; live reporting needs a connected source.'},
    {name:'💴｜fulfilments',topic:'Fulfilment issues, supplier follow-ups and delivery checkpoints.',
      guide:'**Fulfilments**\nUse one thread per shipment, supplier or operational issue.\n\n**Template:** Store/reference • Issue • Next action • Due date • Open / Waiting / Resolved.\n\nLink to the source record where possible and keep customer personal information out of posts.'},
    {name:'🧑‍💻｜support-status',topic:'Customer-support queue summaries, blockers and escalations.',
      guide:'**Support status**\nPost queue summaries and escalations here.\n\n**Template:** Store • New/open/resolved counts • Main blocker • Next action • Next check.\n\nUse links to the source case rather than copying private customer messages.'},
  ]},
  { name:'📡 Status',channels:[
    {name:'agent-status',key:'status',topic:'Live Mac runner availability and agent queue status.'},
  ]},
];

export function privateOverwrites(guildId,ownerId,botId) {
  return [
    {id:guildId,type:OverwriteType.Role,deny:[PermissionFlagsBits.ViewChannel]},
    {id:ownerId,type:OverwriteType.Member,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.AttachFiles,PermissionFlagsBits.CreatePublicThreads,PermissionFlagsBits.SendMessagesInThreads]},
    {id:botId,type:OverwriteType.Member,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.AttachFiles,PermissionFlagsBits.SendMessagesInThreads,PermissionFlagsBits.ManageThreads]},
  ];
}

export async function ensureServerLayout(guild,ownerId,botId) {
  const cache=await guild.channels.fetch();
  const permissions=privateOverwrites(guild.id,ownerId,botId);
  const result={};
  for(const group of SERVER_LAYOUT) {
    let category=cache.find(c=>c?.type===ChannelType.GuildCategory&&c.name===group.name);
    if(!category) {
      category=await guild.channels.create({name:group.name,type:ChannelType.GuildCategory,permissionOverwrites:permissions});
      cache.set(category.id,category);
    }
    for(const spec of group.channels) {
      let channel=cache.find(c=>c?.type===ChannelType.GuildText&&c.name===spec.name);
      if(!channel) {
        channel=await guild.channels.create({name:spec.name,type:ChannelType.GuildText,parent:category.id,permissionOverwrites:permissions,topic:spec.topic});
        cache.set(channel.id,channel);
        if(spec.guide) {
          const guide=await channel.send({content:spec.guide,allowedMentions:{parse:[]}});
          await guide.pin().catch(()=>{});
        }
      } else if(channel.parentId!==category.id) {
        // Moving existing agent channels preserves their IDs, messages and session keys.
        await channel.setParent(category.id,{lockPermissions:false});
      }
      if(spec.key) result[spec.key]=channel;
    }
  }
  return result;
}
