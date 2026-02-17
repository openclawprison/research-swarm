const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com') ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
});

// ============================================================
// SCHEMA
// ============================================================

const SCHEMA = `
CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  phase TEXT DEFAULT 'research',
  total_tasks INT DEFAULT 0,
  completed_tasks INT DEFAULT 0,
  config JSONB DEFAULT '{}',
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  mission_id TEXT REFERENCES missions(id),
  division_id TEXT NOT NULL,
  division_name TEXT NOT NULL,
  queue_id TEXT NOT NULL,
  queue_name TEXT NOT NULL,
  description TEXT NOT NULL,
  search_terms TEXT[] DEFAULT '{}',
  databases TEXT[] DEFAULT '{}',
  status TEXT DEFAULT 'available',
  assigned_to TEXT,
  assigned_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  depth TEXT DEFAULT 'standard',
  topic TEXT
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  status TEXT DEFAULT 'active',
  role TEXT DEFAULT 'worker',
  current_task_id TEXT,
  division_id TEXT,
  queue_id TEXT,
  mission_id TEXT,
  registered_at TIMESTAMPTZ DEFAULT NOW(),
  last_heartbeat TIMESTAMPTZ DEFAULT NOW(),
  disconnected_at TIMESTAMPTZ,
  tasks_completed INT DEFAULT 0,
  papers_analyzed INT DEFAULT 0,
  quality_score REAL DEFAULT 1.0,
  qc_passes INT DEFAULT 0,
  qc_fails INT DEFAULT 0,
  flagged BOOLEAN DEFAULT false,
  max_tasks INT DEFAULT 5
);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  agent_id TEXT,
  task_id TEXT,
  mission_id TEXT,
  division_id TEXT,
  queue_id TEXT,
  title TEXT NOT NULL,
  summary TEXT,
  citations JSONB DEFAULT '[]',
  confidence TEXT DEFAULT 'medium',
  contradictions JSONB DEFAULT '[]',
  gaps JSONB DEFAULT '[]',
  papers_analyzed INT DEFAULT 0,
  verified BOOLEAN DEFAULT false,
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  qc_status TEXT DEFAULT 'pending',
  qc_notes TEXT,
  qc_agent_id TEXT,
  qc_cycle INT DEFAULT 0,
  qc_reviewed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY,
  mission_id TEXT,
  division_id TEXT,
  paper_type TEXT DEFAULT 'division',
  title TEXT,
  abstract TEXT,
  content JSONB DEFAULT '{}',
  citations JSONB DEFAULT '[]',
  generated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS activity_log (
  id SERIAL PRIMARY KEY,
  mission_id TEXT,
  message TEXT,
  type TEXT DEFAULT 'info',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_mission ON tasks(mission_id);
CREATE INDEX IF NOT EXISTS idx_tasks_queue ON tasks(queue_id);
CREATE INDEX IF NOT EXISTS idx_findings_mission ON findings(mission_id);
CREATE INDEX IF NOT EXISTS idx_findings_division ON findings(division_id);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_activity_mission ON activity_log(mission_id);
`;

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(SCHEMA);
    // Migrations — add columns to existing tables
    const migrations = [
      "ALTER TABLE agents ADD COLUMN IF NOT EXISTS quality_score REAL DEFAULT 1.0",
      "ALTER TABLE agents ADD COLUMN IF NOT EXISTS qc_passes INT DEFAULT 0",
      "ALTER TABLE agents ADD COLUMN IF NOT EXISTS qc_fails INT DEFAULT 0",
      "ALTER TABLE agents ADD COLUMN IF NOT EXISTS flagged BOOLEAN DEFAULT false",
      "ALTER TABLE agents ADD COLUMN IF NOT EXISTS max_tasks INT DEFAULT 5",
      "ALTER TABLE findings ADD COLUMN IF NOT EXISTS qc_status TEXT DEFAULT 'pending'",
      "ALTER TABLE findings ADD COLUMN IF NOT EXISTS qc_notes TEXT",
      "ALTER TABLE findings ADD COLUMN IF NOT EXISTS qc_agent_id TEXT",
      "ALTER TABLE findings ADD COLUMN IF NOT EXISTS qc_cycle INT DEFAULT 0",
      "ALTER TABLE findings ADD COLUMN IF NOT EXISTS qc_reviewed_at TIMESTAMPTZ",
    ];
    for (const m of migrations) {
      try { await client.query(m); } catch (e) { /* column already exists */ }
    }
    console.log('✅ Database schema initialized');
  } finally {
    client.release();
  }
}

// ============================================================
// QUERY HELPERS
// ============================================================

const db = {
  query: (text, params) => pool.query(text, params),

  // Missions
  async getMission(id) {
    const r = await pool.query('SELECT * FROM missions WHERE id=$1', [id]);
    return r.rows[0];
  },
  async getActiveMission() {
    const r = await pool.query("SELECT * FROM missions WHERE phase != 'completed' ORDER BY started_at DESC LIMIT 1");
    return r.rows[0];
  },
  async getAllMissions() {
    const r = await pool.query('SELECT * FROM missions ORDER BY started_at DESC');
    return r.rows;
  },
  async upsertMission(m) {
    await pool.query(`INSERT INTO missions (id,name,description,phase,total_tasks,config,started_at)
      VALUES ($1,$2,$3,$4,$5,$6,NOW())
      ON CONFLICT(id) DO UPDATE SET name=$2,description=$3,phase=$4,total_tasks=$5,config=$6`,
      [m.id, m.name, m.description, m.phase || 'research', m.totalTasks || 0, JSON.stringify(m.config || {})]);
  },
  async updateMissionPhase(id, phase) {
    await pool.query('UPDATE missions SET phase=$2, completed_at=CASE WHEN $2=\'completed\' THEN NOW() ELSE completed_at END WHERE id=$1', [id, phase]);
  },
  async updateMissionProgress(id) {
    await pool.query(`UPDATE missions SET completed_tasks=(SELECT COUNT(*) FROM tasks WHERE mission_id=$1 AND status='completed') WHERE id=$1`, [id]);
  },

  // Tasks
  async insertTasks(tasks) {
    if (!tasks.length) return;
    const values = [];
    const params = [];
    let i = 1;
    for (const t of tasks) {
      values.push(`($${i},$${i+1},$${i+2},$${i+3},$${i+4},$${i+5},$${i+6},$${i+7},$${i+8},$${i+9},$${i+10})`);
      params.push(t.id, t.missionId, t.divisionId, t.divisionName, t.queueId, t.queueName, t.description, t.searchTerms || [], t.databases || [], t.depth || 'standard', t.topic || '');
      i += 11;
    }
    // Batch insert in chunks of 500
    const chunkSize = 500;
    for (let c = 0; c < tasks.length; c += chunkSize) {
      const chunk = tasks.slice(c, c + chunkSize);
      const cv = []; const cp = [];
      let ci = 1;
      for (const t of chunk) {
        cv.push(`($${ci},$${ci+1},$${ci+2},$${ci+3},$${ci+4},$${ci+5},$${ci+6},$${ci+7},$${ci+8},$${ci+9},$${ci+10})`);
        cp.push(t.id, t.missionId, t.divisionId, t.divisionName, t.queueId, t.queueName, t.description, t.searchTerms || [], t.databases || [], t.depth || 'standard', t.topic || '');
        ci += 11;
      }
      await pool.query(`INSERT INTO tasks (id,mission_id,division_id,division_name,queue_id,queue_name,description,search_terms,databases,depth,topic)
        VALUES ${cv.join(',')} ON CONFLICT(id) DO NOTHING`, cp);
    }
  },
  async findBestTask(missionId) {
    // Find queue with most available tasks and fewest active agents
    const r = await pool.query(`
      SELECT t.* FROM tasks t
      LEFT JOIN (SELECT queue_id, COUNT(*) as agent_count FROM agents WHERE status='active' AND mission_id=$1 GROUP BY queue_id) a
        ON t.queue_id = a.queue_id
      WHERE t.mission_id=$1 AND t.status='available'
      ORDER BY COALESCE(a.agent_count,0) ASC, RANDOM()
      LIMIT 1`, [missionId]);
    return r.rows[0];
  },
  async assignTask(taskId, agentId) {
    await pool.query("UPDATE tasks SET status='assigned', assigned_to=$2, assigned_at=NOW() WHERE id=$1", [taskId, agentId]);
  },
  async completeTask(taskId) {
    await pool.query("UPDATE tasks SET status='completed', completed_at=NOW() WHERE id=$1", [taskId]);
  },
  async releaseTask(taskId) {
    await pool.query("UPDATE tasks SET status='available', assigned_to=NULL, assigned_at=NULL WHERE id=$1 AND status='assigned'", [taskId]);
  },
  async getTaskStats(missionId) {
    const r = await pool.query(`SELECT status, COUNT(*) as count FROM tasks WHERE mission_id=$1 GROUP BY status`, [missionId]);
    const stats = { available: 0, assigned: 0, completed: 0, total: 0 };
    for (const row of r.rows) { stats[row.status] = parseInt(row.count); stats.total += parseInt(row.count); }
    return stats;
  },
  async getDivisionStats(missionId) {
    const r = await pool.query(`
      SELECT division_id, division_name, queue_id, queue_name, status, COUNT(*) as count
      FROM tasks WHERE mission_id=$1
      GROUP BY division_id, division_name, queue_id, queue_name, status
      ORDER BY division_id, queue_id`, [missionId]);
    return r.rows;
  },
  async getQueueAgentCounts(missionId) {
    const r = await pool.query(`SELECT queue_id, COUNT(*) as count FROM agents WHERE mission_id=$1 AND status='active' GROUP BY queue_id`, [missionId]);
    const m = {};
    for (const row of r.rows) m[row.queue_id] = parseInt(row.count);
    return m;
  },

  // Agents
  async insertAgent(a) {
    await pool.query(`INSERT INTO agents (id,status,role,current_task_id,division_id,queue_id,mission_id,max_tasks)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [a.id, a.status, a.role, a.currentTaskId, a.divisionId, a.queueId, a.missionId, a.maxTasks != null ? a.maxTasks : 5]);
  },
  async getAgent(id) {
    const r = await pool.query('SELECT * FROM agents WHERE id=$1', [id]);
    return r.rows[0];
  },
  async updateAgent(id, fields) {
    const sets = []; const vals = [id]; let i = 2;
    for (const [k, v] of Object.entries(fields)) {
      const col = k.replace(/([A-Z])/g, '_$1').toLowerCase();
      sets.push(`${col}=$${i}`); vals.push(v); i++;
    }
    if (sets.length) await pool.query(`UPDATE agents SET ${sets.join(',')} WHERE id=$1`, vals);
  },
  async getActiveAgents(missionId) {
    const r = await pool.query("SELECT * FROM agents WHERE mission_id=$1 AND status='active' ORDER BY registered_at DESC", [missionId]);
    return r.rows;
  },
  async getAllAgents(missionId) {
    const r = await pool.query("SELECT * FROM agents WHERE mission_id=$1 ORDER BY tasks_completed DESC, registered_at DESC", [missionId]);
    return r.rows;
  },
  async getAgentFindings(agentId) {
    const r = await pool.query("SELECT * FROM findings WHERE agent_id=$1 ORDER BY submitted_at DESC", [agentId]);
    return r.rows;
  },
  async countActiveAgents(missionId) {
    const r = await pool.query("SELECT COUNT(*) FROM agents WHERE mission_id=$1 AND status='active'", [missionId]);
    return parseInt(r.rows[0].count);
  },
  async getTimedOutAgents(timeoutMs) {
    const r = await pool.query("SELECT * FROM agents WHERE status='active' AND last_heartbeat < NOW() - $1 * INTERVAL '1 millisecond'", [timeoutMs]);
    return r.rows;
  },

  // Findings
  async insertFinding(f) {
    await pool.query(`INSERT INTO findings (id,agent_id,task_id,mission_id,division_id,queue_id,title,summary,citations,confidence,contradictions,gaps,papers_analyzed)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [f.id, f.agentId, f.taskId, f.missionId, f.divisionId, f.queueId, f.title, f.summary, JSON.stringify(f.citations), f.confidence, JSON.stringify(f.contradictions || []), JSON.stringify(f.gaps || []), f.papersAnalyzed || 0]);
  },
  async getFindings(missionId, opts = {}) {
    let q = 'SELECT * FROM findings WHERE mission_id=$1';
    const p = [missionId];
    if (opts.division) { q += ` AND division_id=$${p.length + 1}`; p.push(opts.division); }
    if (opts.queue) { q += ` AND queue_id=$${p.length + 1}`; p.push(opts.queue); }
    if (opts.confidence) { q += ` AND confidence=$${p.length + 1}`; p.push(opts.confidence); }
    q += ' ORDER BY submitted_at DESC';
    if (opts.limit) { q += ` LIMIT $${p.length + 1}`; p.push(opts.limit); }
    const r = await pool.query(q, p);
    return r.rows;
  },
  async getFindingById(id) {
    const r = await pool.query('SELECT * FROM findings WHERE id=$1', [id]);
    return r.rows[0];
  },
  async countFindings(missionId) {
    const r = await pool.query('SELECT COUNT(*) FROM findings WHERE mission_id=$1', [missionId]);
    return parseInt(r.rows[0].count);
  },
  async totalPapers(missionId) {
    const r = await pool.query('SELECT COALESCE(SUM(papers_analyzed),0) as total FROM findings WHERE mission_id=$1', [missionId]);
    return parseInt(r.rows[0].total);
  },
  async getAllFindingsForExport(missionId) {
    const r = await pool.query('SELECT * FROM findings WHERE mission_id=$1 ORDER BY division_id, queue_id, submitted_at', [missionId]);
    return r.rows;
  },

  // Papers
  async upsertPaper(p) {
    await pool.query(`INSERT INTO papers (id,mission_id,division_id,paper_type,title,abstract,content,citations,generated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
      ON CONFLICT(id) DO UPDATE SET title=$5,abstract=$6,content=$7,citations=$8,generated_at=NOW()`,
      [p.id, p.missionId, p.divisionId, p.type, p.title, p.abstract, JSON.stringify(p.content), JSON.stringify(p.citations)]);
  },
  async getPapers(missionId) {
    const r = await pool.query('SELECT * FROM papers WHERE mission_id=$1 ORDER BY paper_type, division_id', [missionId]);
    return r.rows;
  },
  async getPaper(id) {
    const r = await pool.query('SELECT * FROM papers WHERE id=$1', [id]);
    return r.rows[0];
  },

  // Activity log
  async log(missionId, msg, type = 'info') {
    await pool.query('INSERT INTO activity_log (mission_id,message,type) VALUES ($1,$2,$3)', [missionId, msg, type]);
    console.log(`[${type.toUpperCase()}] ${msg}`);
  },
  async getRecentActivity(missionId, limit = 100) {
    const r = await pool.query('SELECT * FROM activity_log WHERE mission_id=$1 ORDER BY created_at DESC LIMIT $2', [missionId, limit]);
    return r.rows;
  },

  // QC Functions
  async getFindingsForQC(missionId, { limit = 1, excludeAgentId = null } = {}) {
    // Priority: 1) never reviewed, 2) flagged agent work, 3) oldest reviewed (continuous cycling)
    // Exclude findings by the reviewing agent (don't review your own work)
    let q = `SELECT f.*, a.quality_score as agent_quality, a.flagged as agent_flagged,
      t.description as task_description, t.search_terms as task_search_terms
      FROM findings f
      LEFT JOIN agents a ON f.agent_id = a.id
      LEFT JOIN tasks t ON f.task_id = t.id
      WHERE f.mission_id=$1`;
    const params = [missionId];
    if (excludeAgentId) {
      q += ` AND f.agent_id != $${params.length + 1}`;
      params.push(excludeAgentId);
    }
    q += ` ORDER BY
      CASE WHEN f.qc_status='pending' THEN 0 ELSE 1 END ASC,
      CASE WHEN a.flagged=true THEN 0 ELSE 1 END ASC,
      a.quality_score ASC NULLS LAST,
      f.qc_reviewed_at ASC NULLS FIRST,
      f.submitted_at ASC
      LIMIT $${params.length + 1}`;
    params.push(limit);
    const r = await pool.query(q, params);
    return r.rows;
  },
  async updateFindingQC(findingId, { qcStatus, qcNotes, qcAgentId, qcCycle }) {
    await pool.query(
      `UPDATE findings SET qc_status=$2, qc_notes=$3, qc_agent_id=$4, qc_cycle=$5, qc_reviewed_at=NOW() WHERE id=$1`,
      [findingId, qcStatus, qcNotes, qcAgentId, qcCycle]
    );
  },
  async recalcAgentQuality(agentId) {
    const r = await pool.query(
      `SELECT qc_status, COUNT(*) as cnt FROM findings WHERE agent_id=$1 AND qc_status IN ('passed','flagged','rejected') GROUP BY qc_status`,
      [agentId]
    );
    let passes = 0, fails = 0;
    for (const row of r.rows) {
      if (row.qc_status === 'passed') passes = parseInt(row.cnt);
      else fails += parseInt(row.cnt);
    }
    const total = passes + fails;
    const score = total > 0 ? passes / total : 1.0;
    const flagged = total >= 3 && score < 0.5;
    await pool.query(
      `UPDATE agents SET quality_score=$2, qc_passes=$3, qc_fails=$4, flagged=$5 WHERE id=$1`,
      [agentId, score, passes, fails, flagged]
    );
    return { score, passes, fails, flagged };
  },
  async getQCStats(missionId) {
    const r = await pool.query(
      `SELECT qc_status, COUNT(*) as cnt FROM findings WHERE mission_id=$1 GROUP BY qc_status`,
      [missionId]
    );
    const stats = { pending: 0, passed: 0, flagged: 0, rejected: 0, total: 0 };
    for (const row of r.rows) { stats[row.qc_status] = parseInt(row.cnt); stats.total += parseInt(row.cnt); }
    return stats;
  },
  async getFlaggedAgents(missionId) {
    const r = await pool.query(
      `SELECT * FROM agents WHERE mission_id=$1 AND flagged=true ORDER BY quality_score ASC`,
      [missionId]
    );
    return r.rows;
  },
  async getFindingsByAgent(agentId, { qcStatus } = {}) {
    let q = 'SELECT * FROM findings WHERE agent_id=$1';
    const p = [agentId];
    if (qcStatus) { q += ` AND qc_status=$2`; p.push(qcStatus); }
    q += ' ORDER BY submitted_at DESC';
    const r = await pool.query(q, p);
    return r.rows;
  },
};

module.exports = { pool, initDB, db };
