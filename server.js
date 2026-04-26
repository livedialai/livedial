#!/usr/bin/env node
// dashboard-server.js — Express Dashboard for LiveKit Enhanced Agent

const express = require('express');
const Redis = require('ioredis');
const session = require('express-session');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'enhanced', '.env') });

// ── Config ────────────────────────────────────────────────────────────
const PORT = process.env.DASHBOARD_PORT || 3456;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || '';
const DASHBOARD_USER = process.env.DASHBOARD_USER || 'admin';
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || 'changeme123';
const VICIDIAL_URL = process.env.VICIDIAL_URL || '';

// ── Redis ─────────────────────────────────────────────────────────────
const redis = new Redis({
  host: 'localhost',
  port: 6379,
  password: REDIS_PASSWORD || undefined,
});
redis.on('connect', () => console.log('✅ Dashboard Redis connected'));
redis.on('error', (err) => console.error('❌ Redis error:', err.message));

// ── Express ──────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dashboard-secret-key-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000, httpOnly: true },
}));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth helpers ──────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session.authenticated) return next();
  res.redirect('/login');
}

// ── Login / Logout ───────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session.authenticated) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === DASHBOARD_USER && password === DASHBOARD_PASS) {
    req.session.authenticated = true;
    req.session.username = username;
    console.log(`✅ Dashboard login: ${username}`);
    return res.redirect('/');
  }
  console.log(`❌ Failed login: ${username}`);
  res.redirect('/login?error=1');
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// ── Root ──────────────────────────────────────────────────────────────
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ══════════════════════════════════════════════════════════════════════
//  API ENDPOINTS
// ══════════════════════════════════════════════════════════════════════

// ─ Overview ──────────────────────────────────────────────────────────
app.get('/api/overview', requireAuth, async (req, res) => {
  try {
    const callKeys = await redis.keys('call:*');
    const leadKeys = await redis.keys('lead:*');

    let stats = {
      totalCalls: callKeys.length,
      totalLeads: leadKeys.length,
      positivLeads: 0,
      negativLeads: 0,
      unclearLeads: 0,
      avgDuration: 0,
      totalDuration: 0,
      vicidialUpdates: 0,
    };

    const durations = [];
    for (const key of leadKeys) {
      const data = await redis.get(key);
      if (data) {
        const lead = JSON.parse(data);
        if (lead.status === 'POSITIV') stats.positivLeads++;
        else if (lead.status === 'NEGATIV') stats.negativLeads++;
        else stats.unclearLeads++;
        if (lead.vicidialUpdated) stats.vicidialUpdates++;
      }
    }

    for (const key of callKeys) {
      const data = await redis.get(key);
      if (data) {
        const call = JSON.parse(data);
        if (call.duration) { durations.push(call.duration); stats.totalDuration += call.duration; }
      }
    }

    stats.avgDuration = durations.length > 0 ? Math.round(stats.totalDuration / durations.length) : 0;
    res.json(stats);
  } catch (err) {
    console.error('/api/overview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─ Calls list ────────────────────────────────────────────────────────
app.get('/api/calls', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const filter = req.query.filter || 'all';

    const keys = await redis.keys('call:*');
    const calls = [];
    for (const key of keys) {
      const data = await redis.get(key);
      if (!data) continue;
      const call = JSON.parse(data);

      if (filter !== 'all') {
        if (filter === 'positiv' && call.leadStatus !== 'POSITIV') continue;
        if (filter === 'negativ' && call.leadStatus !== 'NEGATIV') continue;
      }

      call.formattedConversation = (call.conversation || []).map(msg => ({
        speaker: msg.role === 'user' ? 'KUNDE' : msg.role === 'assistant' ? 'NADINE' : msg.role,
        text: msg.content || '',
        time: msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString('de-DE') : '',
      }));
      call.conversationLength = call.conversation?.length || 0;
      calls.push(call);
    }

    calls.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const total = calls.length;
    const start = (page - 1) * limit;
    const paginated = calls.slice(start, start + limit);

    res.json({ calls: paginated, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─ Single call ───────────────────────────────────────────────────────
app.get('/api/call/:callSid', requireAuth, async (req, res) => {
  try {
    const data = await redis.get(`call:${req.params.callSid}`);
    if (!data) return res.status(404).json({ error: 'Call not found' });
    const call = JSON.parse(data);
    call.conversationLength = call.conversation?.length || 0;
    call.formattedConversation = (call.conversation || []).map(msg => ({
      speaker: msg.role === 'user' ? 'KUNDE' : msg.role === 'assistant' ? 'NADINE' : msg.role,
      text: msg.content || '',
      time: msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString('de-DE') : '',
    }));
    res.json(call);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─ Lead details ──────────────────────────────────────────────────────
app.get('/api/lead/:leadId', requireAuth, async (req, res) => {
  try {
    const data = await redis.get(`lead:${req.params.leadId}`);
    if (!data) return res.status(404).json({ error: 'Lead not found' });
    res.json(JSON.parse(data));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─ Timeline ──────────────────────────────────────────────────────────
app.get('/api/stats/timeline', requireAuth, async (req, res) => {
  try {
    const keys = await redis.keys('call:*');
    const timeline = {};
    for (const key of keys) {
      const data = await redis.get(key);
      if (!data) continue;
      const call = JSON.parse(data);
      const date = call.timestamp ? call.timestamp.split('T')[0] : 'unknown';
      if (!timeline[date]) timeline[date] = { date, calls: 0, positiv: 0, negativ: 0, unclear: 0 };
      timeline[date].calls++;
      if (call.leadStatus === 'POSITIV') timeline[date].positiv++;
      else if (call.leadStatus === 'NEGATIV') timeline[date].negativ++;
      else timeline[date].unclear++;
    }
    const result = Object.values(timeline).sort((a, b) => new Date(a.date) - new Date(b.date)).slice(-7);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─ Search ────────────────────────────────────────────────────────────
app.get('/api/search', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').toLowerCase().trim();
    if (!q) return res.json([]);
    const keys = await redis.keys('call:*');
    const results = [];
    for (const key of keys) {
      const data = await redis.get(key);
      if (!data) continue;
      const call = JSON.parse(data);
      const text = (call.conversation || []).map(m => m.content || '').join(' ').toLowerCase();
      if (text.includes(q)) {
        results.push({
          callSid: call.callSid,
          leadId: call.leadId,
          timestamp: call.timestamp,
          leadStatus: call.leadStatus,
          snippet: text.substring(0, 200),
        });
      }
    }
    res.json(results.slice(0, 50));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─ Public stats ──────────────────────────────────────────────────────
app.get('/stats', async (req, res) => {
  try {
    const callKeys = await redis.keys('call:*');
    const leadKeys = await redis.keys('lead:*');
    let p = 0, n = 0, u = 0;
    for (const key of leadKeys) {
      const data = await redis.get(key);
      if (data) {
        const lead = JSON.parse(data);
        if (lead.status === 'POSITIV') p++;
        else if (lead.status === 'NEGATIV') n++;
        else u++;
      }
    }
    res.json({ status: 'ok', totalCalls: callKeys.length, leads: { total: leadKeys.length, positiv: p, negativ: n, unclear: u } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'LiveKit Enhanced Dashboard', uptime: process.uptime() });
});

// ══════════════════════════════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  LIVEKIT ENHANCED AGENT DASHBOARD                          ║
╚══════════════════════════════════════════════════════════════╝

📊 Dashboard: http://localhost:${PORT}
🔐 Login:    ${DASHBOARD_USER} / ${DASHBOARD_PASS}
📈 Stats:    GET http://localhost:${PORT}/stats
❤️  Health:   GET http://localhost:${PORT}/health

Redis:      localhost:6379
ViciDial:   ${VICIDIAL_URL || 'not configured'}
`);
});
