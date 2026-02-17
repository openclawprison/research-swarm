const express = require('express');
const cors = require('cors');
const path = require('path');
const { v4: uuid } = require('uuid');
const { pool, initDB, db } = require('./db');
const { getAllMissions } = require('./missions');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, '..', 'frontend')));

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const HEARTBEAT_TIMEOUT = 3600000;
const QC_RATE = 0.3; // 30% of assignments are QC reviews // 60 min — agents spend long periods researching
const SKILL_PATH = path.join(__dirname, 'SKILL.md');

// ============================================================
// STARTUP — Initialize DB and seed missions
// ============================================================
async function startup() {
  await initDB();
  console.log('🧬 Seeding missions...');
  const missions = getAllMissions();
  let totalTasks = 0;
  for (const m of missions) {
    const existing = await db.getMission(m.id);
    if (!existing) {
      await db.upsertMission(m);
      console.log(`  → Seeding ${m.name}: ${m.tasks.length} tasks...`);
      await db.insertTasks(m.tasks);
      totalTasks += m.tasks.length;
      console.log(`  ✅ ${m.name} seeded`);
    } else {
      console.log(`  → ${m.name} already exists (${existing.total_tasks} tasks)`);
      totalTasks += existing.total_tasks;
    }
  }
  console.log(`\n🧬 RESEARCH SWARM OPERATIONAL`);
  console.log(`   ${missions.length} missions | ${totalTasks.toLocaleString()} total tasks`);
  console.log(`   Dashboard: http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/api/v1/health\n`);

  // Heartbeat monitor disabled — agents stay active until explicit disconnect
  // Stale tasks can be released manually via POST /api/v1/admin/release-stale
}

// ============================================================
// HEARTBEAT MONITOR — Release tasks from dead agents
// ============================================================
async function checkHeartbeats() {
  try {
    const timedOut = await db.getTimedOutAgents(HEARTBEAT_TIMEOUT);
    for (const ag of timedOut) {
      await db.updateAgent(ag.id, { status: 'disconnected', disconnected_at: new Date().toISOString() });
      if (ag.current_task_id) {
        await db.releaseTask(ag.current_task_id);
      }
      const mission = await db.getActiveMission();
      if (mission) await db.log(mission.id, `Agent ${ag.id.slice(0,8)} timed out — task released`, 'leave');
    }
  } catch (e) { console.error('Heartbeat check error:', e.message); }
}

// ============================================================
// MISSION ADVANCEMENT — auto-advance when complete
// ============================================================
async function checkMissionAdvancement(missionId) {
  try {
    const stats = await db.getTaskStats(missionId);
    const mission = await db.getMission(missionId);
    if (!mission) return;

    await db.updateMissionProgress(missionId);

    // Check if research phase is complete
    if (stats.completed >= stats.total && mission.phase === 'research') {
      await db.updateMissionPhase(missionId, 'synthesis');
      await db.log(missionId, `🎉 ALL ${stats.total} TASKS COMPLETED — entering synthesis phase`, 'system');

      // Check if there's a queued mission to activate
      const allMissions = await db.getAllMissions();
      const queued = allMissions.find(m => m.phase === 'queued');
      if (queued) {
        await db.updateMissionPhase(queued.id, 'research');
        await db.log(queued.id, `🚀 Mission activated: ${queued.name}`, 'system');
      }
    }
  } catch (e) { console.error('Advancement check error:', e.message); }
}

// ============================================================
// ASSIGNMENT HELPER — decides research task vs QC review
// ============================================================
async function getNextAssignment(missionId, agentId) {
  const researchTask = await db.findBestTask(missionId);
  const findingCount = await db.countFindings(missionId);

  // Need at least some findings before QC kicks in
  if (findingCount < 5) {
    if (!researchTask) return null;
    return { type: 'research', task: researchTask };
  }

  const shouldQC = Math.random() < QC_RATE;

  if (shouldQC || !researchTask) {
    // Try to get a QC finding (not the agent's own work)
    const findings = await db.getFindingsForQC(missionId, { limit: 1, excludeAgentId: agentId });
    if (findings.length > 0) {
      return { type: 'qc', finding: findings[0] };
    }
  }

  if (researchTask) {
    return { type: 'research', task: researchTask };
  }

  // No research tasks left — always QC
  const findings = await db.getFindingsForQC(missionId, { limit: 1, excludeAgentId: agentId });
  if (findings.length > 0) {
    return { type: 'qc', finding: findings[0] };
  }

  return null;
}

function formatResearchAssignment(agentId, task) {
  return {
    type: 'research',
    taskId: task.id,
    division: task.division_name,
    queue: task.queue_name,
    description: task.description,
    searchTerms: task.search_terms,
    databases: task.databases,
    depth: task.depth,
    submitTo: `/api/v1/agents/${agentId}/findings`,
  };
}

function formatQCAssignment(agentId, finding) {
  return {
    type: 'qc_review',
    findingId: finding.id,
    findingTitle: finding.title,
    findingSummary: finding.summary,
    findingCitations: finding.citations,
    findingConfidence: finding.confidence,
    findingContradictions: finding.contradictions,
    findingGaps: finding.gaps,
    findingDivision: finding.division_id,
    findingQueue: finding.queue_id,
    originalAgentId: finding.agent_id,
    agentQuality: finding.agent_quality,
    agentFlagged: finding.agent_flagged,
    previousQCStatus: finding.qc_status,
    qcCycle: (finding.qc_cycle || 0),
    originalTaskDescription: finding.task_description || '',
    originalSearchTerms: finding.task_search_terms || [],
    submitTo: `/api/v1/agents/${agentId}/qc-submit`,
    instructions: [
      'Re-search the cited sources to verify they exist and support the claims made',
      'Check: Do the cited papers actually exist? Are DOIs/URLs valid?',
      'Check: Does the finding summary accurately reflect what the papers say?',
      'Check: Is the confidence rating appropriate for the evidence quality?',
      'Check: Are there obvious contradictions or gaps the agent missed?',
      'Submit verdict: passed (accurate), flagged (concerns), or rejected (unreliable)',
    ],
  };
}

// ============================================================
// API ROUTES
// ============================================================

// Health
app.get('/api/v1/health', async (req, res) => {
  try {
    const mission = await db.getActiveMission();
    const agents = mission ? await db.countActiveAgents(mission.id) : 0;
    res.json({
      status: 'operational',
      mission: mission?.id || null,
      missionName: mission?.name || null,
      activeAgents: agents,
      uptime: Math.floor(process.uptime()),
    });
  } catch (e) {
    res.json({ status: 'operational', mission: null, activeAgents: 0, uptime: Math.floor(process.uptime()) });
  }
});

// SKILL.md
app.get('/api/v1/skill', (req, res) => {
  try {
    let skill = fs.readFileSync(SKILL_PATH, 'utf8');
    res.type('text/markdown').send(skill);
  } catch (e) {
    res.status(500).json({ error: 'SKILL.md not found' });
  }
});

// ============================================================
// DASHBOARD
// ============================================================
app.get('/api/v1/dashboard', async (req, res) => {
  try {
    const mission = await db.getActiveMission();
    if (!mission) {
      return res.json({ mission: null, stats: {}, divisions: [], recentFindings: [], recentActivity: [], allMissions: await db.getAllMissions() });
    }

    const taskStats = await db.getTaskStats(mission.id);
    const divStats = await db.getDivisionStats(mission.id);
    const agentCounts = await db.getQueueAgentCounts(mission.id);
    const findings = await db.getFindings(mission.id, { limit: 50 });
    const activity = await db.getRecentActivity(mission.id, 100);
    const totalPapers = await db.totalPapers(mission.id);
    const activeAgents = await db.countActiveAgents(mission.id);
    const activeAgentList = await db.getActiveAgents(mission.id);
    const allAgentList = await db.getAllAgents(mission.id);
    const allMissions = await db.getAllMissions();
    const qcStats = await db.getQCStats(mission.id);
    const papers = await db.getPapers(mission.id);

    // Build division structure
    const divMap = {};
    for (const row of divStats) {
      if (!divMap[row.division_id]) {
        divMap[row.division_id] = { id: row.division_id, name: row.division_name, queues: {} };
      }
      if (!divMap[row.division_id].queues[row.queue_id]) {
        divMap[row.division_id].queues[row.queue_id] = { id: row.queue_id, name: row.queue_name, total: 0, completed: 0, assigned: 0, available: 0, agents: agentCounts[row.queue_id] || 0 };
      }
      const q = divMap[row.division_id].queues[row.queue_id];
      q[row.status] = parseInt(row.count);
      q.total += parseInt(row.count);
    }

    const divisions = Object.values(divMap).map(d => ({
      ...d, queues: Object.values(d.queues)
    }));

    res.json({
      mission: { id: mission.id, name: mission.name, description: mission.description, phase: mission.phase },
      stats: {
        activeAgents,
        totalPapers,
        totalFindings: findings.length < 50 ? findings.length : await db.countFindings(mission.id),
        tasksTotal: taskStats.total,
        tasksCompleted: taskStats.completed,
        tasksAssigned: taskStats.assigned,
        tasksAvailable: taskStats.available,
        progress: taskStats.total ? (taskStats.completed / taskStats.total * 100).toFixed(1) : 0,
      },
      divisions,
      recentFindings: findings.map(f => ({
        id: f.id, title: f.title, summary: f.summary,
        division: f.division_id, queue: f.queue_id,
        confidence: f.confidence, citations: f.citations,
        papersAnalyzed: f.papers_analyzed, agentId: f.agent_id,
        submittedAt: f.submitted_at, verified: f.verified,
        contradictions: f.contradictions, gaps: f.gaps,
        qcStatus: f.qc_status || 'pending',
      })),
      recentActivity: activity.map(a => ({ msg: a.message, type: a.type, time: a.created_at })),
      agents: activeAgentList.map(a => ({ id: a.id, status: a.status, divisionId: a.division_id, queueId: a.queue_id, taskId: a.current_task_id, tasksCompleted: a.tasks_completed, papersAnalyzed: a.papers_analyzed, registeredAt: a.registered_at, lastHeartbeat: a.last_heartbeat })),
      allAgents: allAgentList.map(a => ({ id: a.id, status: a.status, divisionId: a.division_id, queueId: a.queue_id, tasksCompleted: a.tasks_completed || 0, papersAnalyzed: a.papers_analyzed || 0, registeredAt: a.registered_at, lastHeartbeat: a.last_heartbeat, disconnectedAt: a.disconnected_at, qualityScore: a.quality_score, qcPasses: a.qc_passes || 0, qcFails: a.qc_fails || 0, flagged: a.flagged || false })),
      qcStats,
      allMissions: allMissions.map(m => ({
        id: m.id, name: m.name, phase: m.phase,
        totalTasks: m.total_tasks, completedTasks: m.completed_tasks,
      })),
      papers: papers.map(p => ({ id: p.id, title: p.title, type: p.paper_type, division: p.division_id, generatedAt: p.generated_at })),
    });
  } catch (e) {
    console.error('Dashboard error:', e);
    res.status(500).json({ error: 'Dashboard error' });
  }
});

// ============================================================
// AGENT REGISTRATION
// ============================================================
app.post('/api/v1/agents/register', async (req, res) => {
  try {
    const mission = await db.getActiveMission();
    if (!mission) return res.status(503).json({ error: 'No active mission' });

    const rawMax = req.body.maxTasks;
    const maxTasks = rawMax === 0 ? 0 : (parseInt(rawMax) || 5); // explicit 0 = unlimited, default = 5
    const agentId = `AG-${uuid().slice(0, 12)}`;
    const assignment = await getNextAssignment(mission.id, agentId);
    if (!assignment) return res.status(503).json({ error: 'No tasks or findings to review', mission: mission.name });

    if (assignment.type === 'research') {
      const task = assignment.task;
      await db.assignTask(task.id, agentId);
      await db.insertAgent({
        id: agentId, status: 'active', role: 'worker',
        currentTaskId: task.id, divisionId: task.division_id,
        queueId: task.queue_id, missionId: mission.id, maxTasks,
      });
      await db.log(mission.id, `Agent ${agentId.slice(0,10)} registered → ${task.division_name} / ${task.queue_name}${maxTasks ? ` (limit: ${maxTasks} tasks)` : ''}`, 'join');

      res.json({
        agentId, maxTasks: maxTasks || 'unlimited',
        mission: { id: mission.id, name: mission.name },
        assignment: formatResearchAssignment(agentId, task),
        instructions: {
          requirements: [
            'Every claim MUST have a citation with: title, authors, journal, year, DOI or URL',
            'Use ONLY open-access databases (PubMed, Semantic Scholar, bioRxiv, etc.)',
            'Rate confidence: high (replicated, large studies) | medium (single studies, small N) | low (preprints, case reports)',
            'Flag contradictions between studies explicitly',
            'Minimum 5 papers analyzed per finding',
            'Include methodology assessment for each cited study',
          ],
        },
      });
    } else {
      const f = assignment.finding;
      await db.insertAgent({
        id: agentId, status: 'active', role: 'qc',
        currentTaskId: null, divisionId: 'qc',
        queueId: 'qc-review', missionId: mission.id, maxTasks,
      });
      await db.log(mission.id, `Agent ${agentId.slice(0,10)} registered → QC review${maxTasks ? ` (limit: ${maxTasks} tasks)` : ''}`, 'join');

      res.json({
        agentId, maxTasks: maxTasks || 'unlimited',
        mission: { id: mission.id, name: mission.name },
        assignment: formatQCAssignment(agentId, f),
      });
    }
  } catch (e) {
    console.error('Registration error:', e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ============================================================
// SUBMIT FINDINGS
// ============================================================
app.post('/api/v1/agents/:id/findings', async (req, res) => {
  try {
    const agent = await db.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found. Re-register at POST /agents/register' });

    // Re-activate agent if it was timed out — it's clearly still working
    if (agent.status !== 'active') {
      await db.updateAgent(agent.id, { status: 'active', last_heartbeat: new Date().toISOString() });
    }

    const { title, summary, citations, confidence, contradictions, gaps, papersAnalyzed } = req.body;
    if (!title || !summary) return res.status(400).json({ error: 'title and summary required' });

    // Validate citations
    const cits = Array.isArray(citations) ? citations : [];
    if (cits.length === 0) {
      return res.status(400).json({ error: 'At least one citation required. Every claim must be backed by evidence.' });
    }

    const findingId = `F-${uuid().slice(0, 12)}`;
    await db.insertFinding({
      id: findingId,
      agentId: agent.id,
      taskId: agent.current_task_id,
      missionId: agent.mission_id,
      divisionId: agent.division_id,
      queueId: agent.queue_id,
      title, summary, citations: cits,
      confidence: confidence || 'medium',
      contradictions: contradictions || [],
      gaps: gaps || [],
      papersAnalyzed: papersAnalyzed || cits.length,
    });

    // Complete current task
    if (agent.current_task_id) {
      await db.completeTask(agent.current_task_id);
    }

    // Update agent stats — always re-activate
    await db.updateAgent(agent.id, {
      status: 'active',
      tasks_completed: (agent.tasks_completed || 0) + 1,
      papers_analyzed: (agent.papers_analyzed || 0) + (papersAnalyzed || cits.length),
      last_heartbeat: new Date().toISOString(),
    });

    await db.log(agent.mission_id, `Agent ${agent.id.slice(0,10)} submitted: "${title}" (${cits.length} citations, ${confidence || 'medium'} confidence)`, 'finding');

    // Check mission advancement
    await checkMissionAdvancement(agent.mission_id);

    // Check task budget
    const tasksNow = (agent.tasks_completed || 0) + 1;
    if (agent.max_tasks > 0 && tasksNow >= agent.max_tasks) {
      await db.updateAgent(agent.id, { status: 'completed', current_task_id: null });
      await db.log(agent.mission_id, `Agent ${agent.id.slice(0,10)} — reached task limit (${tasksNow}/${agent.max_tasks}). Stopping.`, 'system');
      return res.json({ findingId, status: 'accepted', nextAssignment: null, message: `Task limit reached (${tasksNow}/${agent.max_tasks}). Thank you for your contribution.` });
    }

    // Try to assign next task (research or QC)
    const next = await getNextAssignment(agent.mission_id, agent.id);
    if (next) {
      if (next.type === 'research') {
        await db.assignTask(next.task.id, agent.id);
        await db.updateAgent(agent.id, {
          role: 'worker',
          current_task_id: next.task.id,
          division_id: next.task.division_id,
          queue_id: next.task.queue_id,
        });
        await db.log(agent.mission_id, `Agent ${agent.id.slice(0,10)} → next task: ${next.task.queue_name}`, 'info');
        return res.json({
          findingId, status: 'accepted',
          nextAssignment: formatResearchAssignment(agent.id, next.task),
        });
      } else {
        await db.updateAgent(agent.id, { role: 'qc', current_task_id: null, division_id: 'qc', queue_id: 'qc-review' });
        await db.log(agent.mission_id, `Agent ${agent.id.slice(0,10)} → QC review`, 'info');
        return res.json({
          findingId, status: 'accepted',
          nextAssignment: formatQCAssignment(agent.id, next.finding),
        });
      }
    }

    // No more tasks or findings
    await db.updateAgent(agent.id, { status: 'completed', current_task_id: null });
    await db.log(agent.mission_id, `Agent ${agent.id.slice(0,10)} — no more work available`, 'system');

    res.json({ findingId, status: 'accepted', nextAssignment: null, message: 'All tasks completed. Thank you for your contribution.' });
  } catch (e) {
    console.error('Finding submission error:', e);
    res.status(500).json({ error: 'Submission failed' });
  }
});

// ============================================================
// QC SUBMIT — agent submits review verdict
// ============================================================
app.post('/api/v1/agents/:id/qc-submit', async (req, res) => {
  try {
    const agent = await db.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found. Re-register at POST /agents/register' });

    if (agent.status !== 'active') {
      await db.updateAgent(agent.id, { status: 'active', last_heartbeat: new Date().toISOString() });
    }

    const { findingId, verdict, notes } = req.body;
    if (!findingId || !verdict) return res.status(400).json({ error: 'findingId and verdict required' });
    if (!['passed', 'flagged', 'rejected'].includes(verdict)) {
      return res.status(400).json({ error: 'verdict must be: passed, flagged, or rejected' });
    }

    const finding = await db.getFindingById(findingId);
    if (!finding) return res.status(404).json({ error: 'Finding not found' });

    // Record the QC review
    await db.updateFindingQC(finding.id, {
      qcStatus: verdict,
      qcNotes: notes || null,
      qcAgentId: agent.id,
      qcCycle: (finding.qc_cycle || 0) + 1,
    });

    // Recalculate original agent's quality score
    if (finding.agent_id) {
      const quality = await db.recalcAgentQuality(finding.agent_id);
      const mission = await db.getActiveMission();
      if (mission) {
        await db.log(mission.id, `QC ${verdict}: "${finding.title}" by ${finding.agent_id.slice(0,10)} (score: ${(quality.score * 100).toFixed(0)}%) — reviewed by ${agent.id.slice(0,10)}`, 'qc');
        if (quality.flagged) {
          await db.log(mission.id, `⚠ Agent ${finding.agent_id.slice(0,10)} FLAGGED — quality ${(quality.score * 100).toFixed(0)}%`, 'warning');
        }
      }
    }

    // Update QC agent stats
    await db.updateAgent(agent.id, {
      status: 'active',
      tasks_completed: (agent.tasks_completed || 0) + 1,
      last_heartbeat: new Date().toISOString(),
    });

    // Check task budget
    const tasksNow = (agent.tasks_completed || 0) + 1;
    if (agent.max_tasks > 0 && tasksNow >= agent.max_tasks) {
      await db.updateAgent(agent.id, { status: 'completed', current_task_id: null });
      await db.log(agent.mission_id, `Agent ${agent.id.slice(0,10)} — reached task limit (${tasksNow}/${agent.max_tasks}). Stopping.`, 'system');
      return res.json({ status: 'reviewed', verdict, nextAssignment: null, message: `Task limit reached (${tasksNow}/${agent.max_tasks}). Thank you.` });
    }

    // Get next assignment (research or QC)
    const next = await getNextAssignment(agent.mission_id, agent.id);
    if (next) {
      if (next.type === 'research') {
        await db.assignTask(next.task.id, agent.id);
        await db.updateAgent(agent.id, {
          role: 'worker',
          current_task_id: next.task.id,
          division_id: next.task.division_id,
          queue_id: next.task.queue_id,
        });
        await db.log(agent.mission_id, `Agent ${agent.id.slice(0,10)} → next task: ${next.task.queue_name}`, 'info');
        return res.json({
          status: 'reviewed', verdict,
          nextAssignment: formatResearchAssignment(agent.id, next.task),
        });
      } else {
        await db.updateAgent(agent.id, { role: 'qc', current_task_id: null, division_id: 'qc', queue_id: 'qc-review' });
        await db.log(agent.mission_id, `Agent ${agent.id.slice(0,10)} → QC review`, 'info');
        return res.json({
          status: 'reviewed', verdict,
          nextAssignment: formatQCAssignment(agent.id, next.finding),
        });
      }
    }

    await db.updateAgent(agent.id, { status: 'completed', current_task_id: null });
    res.json({ status: 'reviewed', verdict, nextAssignment: null, message: 'No more work available. Thank you.' });
  } catch (e) {
    console.error('QC submit error:', e);
    res.status(500).json({ error: 'QC submission failed' });
  }
});

// ============================================================
// HEARTBEAT
// ============================================================
app.post('/api/v1/agents/:id/heartbeat', async (req, res) => {
  try {
    const agent = await db.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found. Re-register at POST /agents/register' });

    const updates = { last_heartbeat: new Date().toISOString() };

    // Re-activate if it was timed out
    if (agent.status !== 'active') {
      updates.status = 'active';
      // Task was released — assign a new one
      const mission = await db.getActiveMission();
      if (mission) {
        const task = await db.findBestTask(mission.id);
        if (task) {
          await db.assignTask(task.id, agent.id);
          updates.current_task_id = task.id;
          updates.division_id = task.division_id;
          updates.queue_id = task.queue_id;
        }
      }
    }

    await db.updateAgent(agent.id, updates);
    res.json({ status: 'ok', agentId: agent.id, active: true });
  } catch (e) { res.status(500).json({ error: 'Heartbeat failed' }); }
});

// ============================================================
// AGENT PROFILES — all agents, past and present
// ============================================================
app.get('/api/v1/agents', async (req, res) => {
  try {
    const mission = await db.getActiveMission();
    if (!mission) return res.json([]);
    const agents = await db.getAllAgents(mission.id);
    res.json(agents.map(a => ({
      id: a.id, status: a.status, divisionId: a.division_id, queueId: a.queue_id,
      tasksCompleted: a.tasks_completed || 0, papersAnalyzed: a.papers_analyzed || 0,
      registeredAt: a.registered_at, lastHeartbeat: a.last_heartbeat,
      disconnectedAt: a.disconnected_at,
    })));
  } catch (e) { res.status(500).json({ error: 'Failed to list agents' }); }
});

app.get('/api/v1/agents/:id/profile', async (req, res) => {
  try {
    const agent = await db.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const findings = await db.getAgentFindings(agent.id);
    const divisionSet = new Set(); const queueSet = new Set();
    findings.forEach(f => { divisionSet.add(f.division_id); queueSet.add(f.queue_id); });
    const totalCitations = findings.reduce((s, f) => s + (Array.isArray(f.citations) ? f.citations.length : 0), 0);
    const avgConfidence = findings.length ? findings.filter(f => f.confidence === 'high').length / findings.length : 0;
    const activeMinutes = agent.last_heartbeat && agent.registered_at
      ? Math.round((new Date(agent.last_heartbeat) - new Date(agent.registered_at)) / 60000) : 0;

    res.json({
      id: agent.id, status: agent.status,
      registeredAt: agent.registered_at, lastActive: agent.last_heartbeat,
      disconnectedAt: agent.disconnected_at,
      tasksCompleted: agent.tasks_completed || 0,
      papersAnalyzed: agent.papers_analyzed || 0,
      totalCitations,
      highConfidenceRate: Math.round(avgConfidence * 100),
      divisionsWorked: divisionSet.size,
      queuesWorked: queueSet.size,
      activeMinutes,
      findings: findings.map(f => ({
        id: f.id, title: f.title, summary: f.summary,
        division: f.division_id, queue: f.queue_id,
        confidence: f.confidence, citationCount: Array.isArray(f.citations) ? f.citations.length : 0,
        citations: f.citations, contradictions: f.contradictions, gaps: f.gaps,
        submittedAt: f.submitted_at,
      })),
    });
  } catch (e) { res.status(500).json({ error: 'Failed to get agent profile' }); }
});

// ============================================================
// DISCONNECT
// ============================================================
app.post('/api/v1/agents/:id/disconnect', async (req, res) => {
  try {
    const agent = await db.getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    await db.updateAgent(agent.id, { status: 'disconnected', disconnected_at: new Date().toISOString(), current_task_id: null });
    if (agent.current_task_id) await db.releaseTask(agent.current_task_id);
    await db.log(agent.mission_id, `Agent ${agent.id.slice(0,10)} disconnected gracefully (${agent.tasks_completed || 0} tasks completed)`, 'leave');
    res.json({ status: 'disconnected', tasksCompleted: agent.tasks_completed || 0 });
  } catch (e) { res.status(500).json({ error: 'Disconnect failed' }); }
});

// ============================================================
// ADMIN — manually release stale agents (no auto-timeout)
// ============================================================
app.post('/api/v1/admin/release-stale', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'] || req.query.key;
    if (!ADMIN_KEY || key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
    const hours = parseInt(req.query.hours) || 2;
    const stale = await db.getTimedOutAgents(hours * 3600000);
    let released = 0;
    for (const ag of stale) {
      await db.updateAgent(ag.id, { status: 'disconnected', disconnected_at: new Date().toISOString() });
      if (ag.current_task_id) { await db.releaseTask(ag.current_task_id); released++; }
      const mission = await db.getActiveMission();
      if (mission) await db.log(mission.id, `Agent ${ag.id.slice(0,8)} manually released (stale ${hours}h)`, 'leave');
    }
    res.json({ released, agents: stale.length });
  } catch (e) { res.status(500).json({ error: 'Release failed' }); }
});

// ============================================================
// QUALITY CONTROL — review, flag, cycle
// ============================================================

// QC stats overview
app.get('/api/v1/qc/stats', async (req, res) => {
  try {
    const mission = await db.getActiveMission();
    if (!mission) return res.json({ error: 'No active mission' });
    const qcStats = await db.getQCStats(mission.id);
    const flaggedAgents = await db.getFlaggedAgents(mission.id);
    res.json({
      ...qcStats,
      reviewRate: qcStats.total ? Math.round(((qcStats.passed + qcStats.flagged + qcStats.rejected) / qcStats.total) * 100) : 0,
      flaggedAgents: flaggedAgents.length,
      agents: flaggedAgents.map(a => ({
        id: a.id, qualityScore: a.quality_score, qcPasses: a.qc_passes, qcFails: a.qc_fails,
        tasksCompleted: a.tasks_completed,
      })),
    });
  } catch (e) { res.status(500).json({ error: 'QC stats failed' }); }
});

// Get next finding to QC review — prioritizes low-quality agent work
app.get('/api/v1/qc/next', async (req, res) => {
  try {
    const mission = await db.getActiveMission();
    if (!mission) return res.status(503).json({ error: 'No active mission' });
    const cycle = parseInt(req.query.cycle) || 0;
    const findings = await db.getFindingsForQC(mission.id, { cycle, limit: 1, prioritizeLowQuality: true });
    if (findings.length === 0) return res.json({ finding: null, message: 'All findings reviewed for this cycle.' });
    const f = findings[0];
    res.json({
      finding: {
        id: f.id, title: f.title, summary: f.summary, citations: f.citations,
        confidence: f.confidence, contradictions: f.contradictions, gaps: f.gaps,
        division: f.division_id, queue: f.queue_id, agentId: f.agent_id,
        agentQuality: f.agent_quality, agentFlagged: f.agent_flagged,
        qcCycle: f.qc_cycle, qcStatus: f.qc_status,
        submittedAt: f.submitted_at,
      },
    });
  } catch (e) { res.status(500).json({ error: 'QC next failed' }); }
});

// Submit QC review for a finding
app.post('/api/v1/qc/review/:findingId', async (req, res) => {
  try {
    const { verdict, notes, reviewerAgentId, cycle } = req.body;
    if (!verdict || !['passed', 'flagged', 'rejected'].includes(verdict)) {
      return res.status(400).json({ error: 'verdict required: passed, flagged, or rejected' });
    }
    const finding = await db.getFindingById(req.params.findingId);
    if (!finding) return res.status(404).json({ error: 'Finding not found' });

    await db.updateFindingQC(finding.id, {
      qcStatus: verdict,
      qcNotes: notes || null,
      qcAgentId: reviewerAgentId || null,
      qcCycle: (cycle || finding.qc_cycle || 0) + 1,
    });

    // Recalculate the original agent's quality score
    if (finding.agent_id) {
      const quality = await db.recalcAgentQuality(finding.agent_id);
      const mission = await db.getActiveMission();
      if (mission) {
        await db.log(mission.id, `QC ${verdict}: "${finding.title}" (agent ${finding.agent_id.slice(0,10)} score: ${(quality.score * 100).toFixed(0)}%)`, 'qc');
        if (quality.flagged) {
          await db.log(mission.id, `⚠ Agent ${finding.agent_id.slice(0,10)} FLAGGED — quality ${(quality.score * 100).toFixed(0)}% (${quality.fails} fails / ${quality.passes + quality.fails} reviewed)`, 'warning');
        }
      }
    }

    // Get next finding to review
    const missionId = finding.mission_id;
    const nextFindings = await db.getFindingsForQC(missionId, { cycle: cycle || 0, limit: 1, prioritizeLowQuality: true });
    const next = nextFindings[0] || null;

    res.json({
      status: 'reviewed',
      findingId: finding.id,
      verdict,
      nextFinding: next ? {
        id: next.id, title: next.title, summary: next.summary, citations: next.citations,
        confidence: next.confidence, contradictions: next.contradictions, gaps: next.gaps,
        division: next.division_id, queue: next.queue_id, agentId: next.agent_id,
        agentQuality: next.agent_quality, agentFlagged: next.agent_flagged,
        qcCycle: next.qc_cycle, qcStatus: next.qc_status,
      } : null,
    });
  } catch (e) { console.error('QC review error:', e); res.status(500).json({ error: 'QC review failed' }); }
});

// Reset QC cycle — allows re-reviewing all findings (or just flagged ones)
app.post('/api/v1/qc/reset-cycle', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'] || req.query.key;
    if (!ADMIN_KEY || key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });
    const mission = await db.getActiveMission();
    if (!mission) return res.status(503).json({ error: 'No active mission' });
    const { scope } = req.body; // 'all', 'flagged', 'low-quality'
    let q, params;
    if (scope === 'flagged') {
      q = `UPDATE findings SET qc_status='pending' WHERE mission_id=$1 AND qc_status='flagged'`;
      params = [mission.id];
    } else if (scope === 'low-quality') {
      q = `UPDATE findings SET qc_status='pending' WHERE mission_id=$1 AND agent_id IN (SELECT id FROM agents WHERE flagged=true)`;
      params = [mission.id];
    } else {
      q = `UPDATE findings SET qc_status='pending' WHERE mission_id=$1`;
      params = [mission.id];
    }
    const r = await pool.query(q, params);
    await db.log(mission.id, `QC cycle reset (${scope || 'all'}) — ${r.rowCount} findings queued for re-review`, 'system');
    res.json({ reset: r.rowCount, scope: scope || 'all' });
  } catch (e) { res.status(500).json({ error: 'QC reset failed' }); }
});

// List flagged agents
app.get('/api/v1/qc/flagged-agents', async (req, res) => {
  try {
    const mission = await db.getActiveMission();
    if (!mission) return res.json([]);
    const agents = await db.getFlaggedAgents(mission.id);
    res.json(agents.map(a => ({
      id: a.id, status: a.status, qualityScore: a.quality_score,
      qcPasses: a.qc_passes, qcFails: a.qc_fails,
      tasksCompleted: a.tasks_completed, papersAnalyzed: a.papers_analyzed,
    })));
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// ============================================================
// FINDINGS — list, single, export
// ============================================================
app.get('/api/v1/findings', async (req, res) => {
  try {
    const missionId = req.query.mission;
    const mission = missionId ? await db.getMission(missionId) : await db.getActiveMission();
    if (!mission) return res.json([]);
    const findings = await db.getFindings(mission.id, {
      division: req.query.division,
      queue: req.query.queue,
      confidence: req.query.confidence,
      limit: parseInt(req.query.limit) || 200,
    });
    res.json(findings.map(f => ({
      id: f.id, title: f.title, summary: f.summary, division: f.division_id,
      queue: f.queue_id, confidence: f.confidence, citations: f.citations,
      contradictions: f.contradictions, gaps: f.gaps,
      papersAnalyzed: f.papers_analyzed, agentId: f.agent_id,
      submittedAt: f.submitted_at, verified: f.verified,
    })));
  } catch (e) { res.status(500).json({ error: 'Failed to fetch findings' }); }
});

app.get('/api/v1/findings/:id', async (req, res) => {
  try {
    const f = await db.getFindingById(req.params.id);
    if (!f) return res.status(404).json({ error: 'Not found' });
    res.json(f);
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// ============================================================
// EXPORT — JSON + CSV download
// ============================================================
app.get('/api/v1/export/findings', async (req, res) => {
  try {
    const missionId = req.query.mission;
    const mission = missionId ? await db.getMission(missionId) : await db.getActiveMission();
    if (!mission) return res.status(404).json({ error: 'No mission found' });

    const findings = await db.getAllFindingsForExport(mission.id);
    const format = req.query.format || 'json';

    if (format === 'csv') {
      const header = 'id,title,division,queue,confidence,papers_analyzed,citations_count,submitted_at,agent_id,verified,summary\n';
      const rows = findings.map(f =>
        `"${f.id}","${(f.title||'').replace(/"/g,'""')}","${f.division_id}","${f.queue_id}","${f.confidence}",${f.papers_analyzed},${(f.citations||[]).length},"${f.submitted_at}","${f.agent_id}",${f.verified},"${(f.summary||'').replace(/"/g,'""').replace(/\n/g,' ')}"`
      ).join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="research-swarm-${mission.id}-findings.csv"`);
      return res.send(header + rows);
    }

    // Full JSON export with all citations
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="research-swarm-${mission.id}-findings.json"`);
    res.json({
      mission: { id: mission.id, name: mission.name, exportedAt: new Date().toISOString() },
      totalFindings: findings.length,
      totalCitations: findings.reduce((s, f) => s + (f.citations || []).length, 0),
      findings: findings.map(f => ({
        id: f.id, title: f.title, summary: f.summary,
        division: f.division_id, queue: f.queue_id,
        confidence: f.confidence, papersAnalyzed: f.papers_analyzed,
        citations: f.citations, contradictions: f.contradictions,
        gaps: f.gaps, agentId: f.agent_id,
        submittedAt: f.submitted_at, verified: f.verified,
      })),
    });
  } catch (e) {
    console.error('Export error:', e);
    res.status(500).json({ error: 'Export failed' });
  }
});

// ============================================================
// PAPER GENERATION — compile findings into research papers
// ============================================================
app.post('/api/v1/papers/generate', async (req, res) => {
  try {
    const key = req.headers['x-admin-key'] || req.query.key;
    if (!ADMIN_KEY || key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized — paper generation is admin-only' });
    const { missionId, divisionId, type } = req.body; // type: 'division' | 'comprehensive'
    const mission = missionId ? await db.getMission(missionId) : await db.getActiveMission();
    if (!mission) return res.status(404).json({ error: 'No mission found' });

    if (type === 'division' && divisionId) {
      // Generate a division paper
      const findings = await db.getFindings(mission.id, { division: divisionId });
      if (findings.length === 0) return res.status(400).json({ error: 'No findings in this division yet' });

      const allCitations = [];
      findings.forEach(f => {
        if (Array.isArray(f.citations)) allCitations.push(...f.citations);
      });
      const uniqueCitations = deduplicateCitations(allCitations);

      const paper = {
        id: `paper-${mission.id}-${divisionId}`,
        missionId: mission.id,
        divisionId,
        type: 'division',
        title: `${divisionId} — Systematic Review | ${mission.name}`,
        abstract: `Compiled from ${findings.length} research findings across ${uniqueCitations.length} unique sources.`,
        content: {
          findings: findings.map(f => ({
            title: f.title, summary: f.summary, confidence: f.confidence,
            citations: f.citations, contradictions: f.contradictions, gaps: f.gaps,
          })),
          totalFindings: findings.length,
          highConfidence: findings.filter(f => f.confidence === 'high').length,
          mediumConfidence: findings.filter(f => f.confidence === 'medium').length,
          lowConfidence: findings.filter(f => f.confidence === 'low').length,
        },
        citations: uniqueCitations,
      };

      await db.upsertPaper(paper);
      await db.log(mission.id, `📄 Division paper generated: ${divisionId} (${findings.length} findings, ${uniqueCitations.length} citations)`, 'system');
      return res.json({ paperId: paper.id, title: paper.title, findingsCount: findings.length, citationsCount: uniqueCitations.length });
    }

    // Comprehensive paper — all divisions
    const findings = await db.getAllFindingsForExport(mission.id);
    if (findings.length === 0) return res.status(400).json({ error: 'No findings yet' });

    const allCitations = [];
    findings.forEach(f => {
      if (Array.isArray(f.citations)) allCitations.push(...f.citations);
    });
    const uniqueCitations = deduplicateCitations(allCitations);

    // Group by division
    const byDiv = {};
    for (const f of findings) {
      if (!byDiv[f.division_id]) byDiv[f.division_id] = [];
      byDiv[f.division_id].push(f);
    }

    const paper = {
      id: `paper-${mission.id}-comprehensive`,
      missionId: mission.id,
      divisionId: 'all',
      type: 'comprehensive',
      title: `Comprehensive Systematic Review: ${mission.name}`,
      abstract: `Multi-agent systematic review compiled from ${findings.length} findings across ${Object.keys(byDiv).length} research divisions, citing ${uniqueCitations.length} unique sources.`,
      content: {
        divisions: Object.entries(byDiv).map(([div, fds]) => ({
          division: div,
          findingsCount: fds.length,
          findings: fds.map(f => ({
            title: f.title, summary: f.summary, confidence: f.confidence,
            citations: f.citations, contradictions: f.contradictions, gaps: f.gaps,
          })),
        })),
        statistics: {
          totalFindings: findings.length,
          totalDivisions: Object.keys(byDiv).length,
          totalCitations: uniqueCitations.length,
          highConfidence: findings.filter(f => f.confidence === 'high').length,
          mediumConfidence: findings.filter(f => f.confidence === 'medium').length,
          lowConfidence: findings.filter(f => f.confidence === 'low').length,
          contradictions: findings.filter(f => f.contradictions && f.contradictions.length > 0).length,
          gaps: findings.filter(f => f.gaps && f.gaps.length > 0).length,
        },
      },
      citations: uniqueCitations,
    };

    await db.upsertPaper(paper);
    await db.log(mission.id, `📋 COMPREHENSIVE PAPER generated: ${findings.length} findings, ${uniqueCitations.length} citations across ${Object.keys(byDiv).length} divisions`, 'system');
    res.json({ paperId: paper.id, title: paper.title, findingsCount: findings.length, divisionsCount: Object.keys(byDiv).length, citationsCount: uniqueCitations.length });
  } catch (e) {
    console.error('Paper generation error:', e);
    res.status(500).json({ error: 'Paper generation failed' });
  }
});

// Get paper
app.get('/api/v1/papers', async (req, res) => {
  try {
    const missionId = req.query.mission;
    const mission = missionId ? await db.getMission(missionId) : await db.getActiveMission();
    if (!mission) return res.json([]);
    const papers = await db.getPapers(mission.id);
    res.json(papers);
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

app.get('/api/v1/papers/:id', async (req, res) => {
  try {
    const paper = await db.getPaper(req.params.id);
    if (!paper) return res.status(404).json({ error: 'Not found' });
    res.json(paper);
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// Export paper as downloadable JSON
app.get('/api/v1/papers/:id/export', async (req, res) => {
  try {
    const paper = await db.getPaper(req.params.id);
    if (!paper) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${paper.id}.json"`);
    res.json(paper);
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// ============================================================
// MISSIONS — list, switch
// ============================================================
app.get('/api/v1/missions', async (req, res) => {
  try {
    const missions = await db.getAllMissions();
    res.json(missions.map(m => ({
      id: m.id, name: m.name, description: m.description,
      phase: m.phase, totalTasks: m.total_tasks,
      completedTasks: m.completed_tasks, startedAt: m.started_at, completedAt: m.completed_at,
    })));
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

app.post('/api/v1/missions/:id/activate', async (req, res) => {
  try {
    const mission = await db.getMission(req.params.id);
    if (!mission) return res.status(404).json({ error: 'Mission not found' });
    // Pause current active mission
    const active = await db.getActiveMission();
    if (active && active.id !== mission.id) {
      await db.updateMissionPhase(active.id, 'paused');
    }
    await db.updateMissionPhase(mission.id, 'research');
    await db.log(mission.id, `🚀 Mission activated: ${mission.name}`, 'system');
    res.json({ status: 'activated', mission: mission.name });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// ============================================================
// STATS
// ============================================================
app.get('/api/v1/stats', async (req, res) => {
  try {
    const missions = await db.getAllMissions();
    let totalTasks = 0, completedTasks = 0, totalFindings = 0, totalPapers = 0;
    for (const m of missions) {
      totalTasks += m.total_tasks || 0;
      completedTasks += m.completed_tasks || 0;
      totalFindings += await db.countFindings(m.id);
      totalPapers += await db.totalPapers(m.id);
    }
    res.json({
      missions: missions.length,
      totalTasks,
      completedTasks,
      totalFindings,
      totalPapers,
      activeMission: (await db.getActiveMission())?.name || null,
    });
  } catch (e) { res.status(500).json({ error: 'Failed' }); }
});

// ============================================================
// CITATION DEDUP HELPER
// ============================================================
function deduplicateCitations(citations) {
  const seen = new Map();
  for (const c of citations) {
    const key = (typeof c === 'string') ? c : (c.doi || c.title || JSON.stringify(c));
    if (!seen.has(key)) seen.set(key, c);
  }
  return Array.from(seen.values());
}

// ============================================================
// SPA FALLBACK
// ============================================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// ============================================================
// START
// ============================================================
app.listen(PORT, () => {
  console.log(`\n🌐 Server starting on port ${PORT}...`);
  startup().catch(e => {
    console.error('❌ Startup failed:', e);
    process.exit(1);
  });
});
