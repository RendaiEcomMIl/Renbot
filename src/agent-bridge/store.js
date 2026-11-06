import { randomUUID } from 'node:crypto';

// Claimed jobs are never automatically executed again after an uncertain failure.
export class AgentStore {
  constructor(pool) { this.pool = pool; }
  async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS renbot_agent_conversations (key TEXT PRIMARY KEY, generation TEXT NOT NULL, agent TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS renbot_agent_jobs (
        id TEXT PRIMARY KEY, message_id TEXT UNIQUE NOT NULL, channel_id TEXT NOT NULL,
        owner_id TEXT NOT NULL, conversation TEXT NOT NULL, agent TEXT NOT NULL,
        prompt TEXT NOT NULL, attachments JSONB NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'queued', cancel_requested BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), claimed_at TIMESTAMPTZ,
        heartbeat_at TIMESTAMPTZ, worker_id TEXT, result TEXT, reply_ids JSONB NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS renbot_agent_meta (key TEXT PRIMARY KEY, value JSONB NOT NULL);
      CREATE INDEX IF NOT EXISTS renbot_agent_jobs_status ON renbot_agent_jobs(status, created_at);
    `);
  }
  async conversation(key, agent, reset = false) {
    const { rows } = await this.pool.query(`
      INSERT INTO renbot_agent_conversations(key,generation,agent) VALUES ($1,$2,$3)
      ON CONFLICT(key) DO UPDATE SET
        generation=CASE WHEN $4 OR renbot_agent_conversations.agent <> $3 THEN $2 ELSE renbot_agent_conversations.generation END,
        agent=$3 RETURNING generation,agent`, [key, randomUUID(), agent, reset]);
    return rows[0];
  }
  async agent(key) {
    return (await this.pool.query('SELECT agent FROM renbot_agent_conversations WHERE key=$1',[key])).rows[0]?.agent;
  }
  async enqueue(job) {
    const { rows } = await this.pool.query(`
      INSERT INTO renbot_agent_jobs(id,message_id,channel_id,owner_id,conversation,agent,prompt,attachments)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8 WHERE
        (SELECT COUNT(*) FROM renbot_agent_jobs WHERE status IN ('queued','running')) < 10
      ON CONFLICT(message_id) DO NOTHING RETURNING *`,
    [randomUUID(),job.messageId,job.channelId,job.ownerId,job.conversation,job.agent,job.prompt,JSON.stringify(job.attachments)]);
    return rows[0];
  }
  async workerSeen(workerId) {
    await this.pool.query(`INSERT INTO renbot_agent_meta(key,value) VALUES ('worker',$1)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify({workerId,at:Date.now()})]);
  }
  async claim(workerId) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(8675309)');
      await db.query(`UPDATE renbot_agent_jobs SET status='failed',result='Worker disconnected. This task was not automatically retried. Check its work before sending another request.'
        WHERE status='running' AND heartbeat_at < NOW() - INTERVAL '2 minutes'`);
      await db.query(`UPDATE renbot_agent_jobs SET status='failed',result='This message expired while the Mac was offline. Please send it again.'
        WHERE status='queued' AND created_at < NOW() - INTERVAL '30 minutes'`);
      const busy = await db.query(`SELECT 1 FROM renbot_agent_jobs WHERE status='running' LIMIT 1`);
      let job = null;
      if (!busy.rowCount) job = (await db.query(`UPDATE renbot_agent_jobs SET status='running',worker_id=$1,claimed_at=NOW(),heartbeat_at=NOW()
        WHERE id=(SELECT id FROM renbot_agent_jobs WHERE status='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING *`,[workerId])).rows[0] || null;
      await db.query('COMMIT'); return job;
    } catch(error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }
  async heartbeat(id,workerId) {
    return (await this.pool.query(`UPDATE renbot_agent_jobs SET heartbeat_at=NOW()
      WHERE id=$1 AND worker_id=$2 AND status='running' RETURNING cancel_requested,channel_id`,[id,workerId])).rows[0];
  }
  async complete(id,workerId,result,failed) {
    const { rows } = await this.pool.query(`UPDATE renbot_agent_jobs SET status=$4,result=$3,heartbeat_at=NOW()
      WHERE id=$1 AND worker_id=$2 AND status='running' RETURNING *`,[id,workerId,result,failed?'failed':'completed']);
    return rows[0] || (await this.pool.query('SELECT * FROM renbot_agent_jobs WHERE id=$1 AND worker_id=$2',[id,workerId])).rows[0];
  }
  async cancel(channelId,ownerId) {
    return (await this.pool.query(`UPDATE renbot_agent_jobs SET cancel_requested=true,
      status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END
      WHERE channel_id=$1 AND owner_id=$2 AND status IN ('queued','running') RETURNING id`,[channelId,ownerId])).rows.length;
  }
  async undelivered() {
    return (await this.pool.query(`SELECT * FROM renbot_agent_jobs WHERE status IN ('completed','failed')
      AND jsonb_array_length(reply_ids)=0 ORDER BY created_at LIMIT 10`)).rows;
  }
  async delivered(id,ids) {
    await this.pool.query('UPDATE renbot_agent_jobs SET reply_ids=$2 WHERE id=$1',[id,JSON.stringify(ids)]);
  }
  async status() {
    const meta=await this.pool.query(`SELECT value FROM renbot_agent_meta WHERE key='worker'`);
    const jobs=await this.pool.query(`SELECT status,COUNT(*)::int AS count FROM renbot_agent_jobs
      WHERE status IN ('queued','running') GROUP BY status`);
    return {workerOnline:Date.now()-(meta.rows[0]?.value?.at||0)<60000,jobs:jobs.rows};
  }
  async meta(key) {
    return (await this.pool.query('SELECT value FROM renbot_agent_meta WHERE key=$1',[key])).rows[0]?.value;
  }
  async setMeta(key,value) {
    await this.pool.query(`INSERT INTO renbot_agent_meta(key,value) VALUES ($1,$2)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`,[key,JSON.stringify(value)]);
  }
}
