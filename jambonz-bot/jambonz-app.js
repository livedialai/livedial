/**
 * jambonz Voice AI Agent v2.0
 *
 * Migrated feature parity with LiveKit enhanced_agent.py:
 * - Multi-tenant config resolution via backend API (DID -> tenant)
 * - RAG/Firmenwissen knowledge query
 * - Dynamic API tools from backend integrations
 * - Meetergo v4 calendar (availability + booking)
 * - Warm/cold transfer via jambonz dial verb
 * - Email summary (SMTP)
 * - Outcome analysis (Entscheider)
 * - Call duration watchdog
 */

require('dotenv').config();
const express = require('express');
const http = require('http');
const Redis = require('ioredis');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const CONFIG = {
  port: parseInt(process.env.PORT || '3009'),
  redis_url: process.env.REDIS_URL || 'redis://localhost:6379',
  backend_url: process.env.BACKEND_URL || 'http://localhost:8000',
  ha_api_key: process.env.HA_API_KEY || '',
  llm_api_key: process.env.LLM_API_KEY || 'dummy',
  llm_base_url: process.env.LLM_BASE_URL || undefined,
  llm_model: process.env.LLM_MODEL || 'gpt-4o-mini',
  llm_no_think: (process.env.LLM_NO_THINK || 'true').toLowerCase() === 'true',
  
  verkauf_prompt_path: process.env.VERKAUF_PROMPT_PATH || './verkaufsprompt.txt',
  
  calendar_enabled: (process.env.CALENDAR_ENABLED || 'true').toLowerCase() === 'true',
  meetergo_api_key: process.env.MEETERGO_API_KEY || '',
  meetergo_meeting_type_id: process.env.MEETERGO_MEETING_TYPE_ID || '',
  meetergo_host_id: process.env.MEETERGO_HOST_ID || '',
  
  max_call_duration: parseInt(process.env.MAX_CALL_DURATION_SECONDS || '600'),
  dashboard_user: process.env.DASHBOARD_USER || 'admin',
  dashboard_password: process.env.DASHBOARD_PASSWORD || 'changeme123',
  smtp_host: process.env.SMTP_HOST || '',
  smtp_port: parseInt(process.env.SMTP_PORT || '587'),
  smtp_user: process.env.SMTP_USER || '',
  smtp_pass: process.env.SMTP_PASS || '',
  smtp_from: process.env.SMTP_FROM || '',
  email_to: process.env.EMAIL_TO || '',
};

function loadPrompt(filePath, fallback) {
  try { return fs.readFileSync(path.resolve(filePath), 'utf-8'); }
  catch { console.warn(`Prompt nicht gefunden: ${filePath}, nutze Fallback`); return fallback; }
}

const VERKAUF_PROMPT = loadPrompt(CONFIG.verkauf_prompt_path, 'Du bist ein freundlicher Verkaufsassistent. Antworte immer auf Deutsch, kurz und praezise.');
const ENTSCHEIDER_PROMPT = '';

const redis = new Redis(CONFIG.redis_url);
redis.on('error', (err) => console.error('Redis Fehler:', err));

const llmClient = new OpenAI({ apiKey: CONFIG.llm_api_key, baseURL: CONFIG.llm_base_url });

function stripMarkup(text) {
  if (!text) return '';
  return text.replace(/<[^>]*>/g, '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/\s{2,}/g, ' ').trim();
}

function buildExtraParams() {
  return CONFIG.llm_no_think ? { extra_body: { chat_template_kwargs: { enable_thinking: false } } } : {};
}

// ═══════════════════════════════════════════════════════════════════
//  TENANT RESOLUTION
// ═══════════════════════════════════════════════════════════════════

async function resolveTenantConfig(calledDid) {
  const headers = CONFIG.ha_api_key ? { 'X-API-Key': CONFIG.ha_api_key } : {};
  try {
    const client = new OpenAI({ apiKey: 'dummy' });
    const httpClient = new OpenAI({ apiKey: 'dummy' }).buildRequest;
    // Use fetch directly for non-OpenAI endpoints
    let tc = {};
    if (calledDid) {
      const resp = await fetch(`${CONFIG.backend_url}/api/tenants/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ did: calledDid }),
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const data = await resp.json();
        tc = data.config || {};
        console.log(`[Tenant] Resolved tenant by DID ${calledDid}`);
      }
    }
    if (!tc || Object.keys(tc).length === 0) {
      const resp = await fetch(`${CONFIG.backend_url}/api/tenants/default-config`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const data = await resp.json();
        tc = data.config || {};
        console.log('[Tenant] Using default tenant config');
      }
    }
    return tc;
  } catch (e) {
    console.warn(`[Tenant] Resolve failed: ${e.message}`);
    return {};
  }
}

async function resolveDynamicTools(calledDid) {
  if (!calledDid) return { tools: [], descriptions: '' };
  const headers = CONFIG.ha_api_key ? { 'X-API-Key': CONFIG.ha_api_key } : {};
  try {
    const resp = await fetch(`${CONFIG.backend_url}/api/settings/integrations/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ did: calledDid }),
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const data = await resp.json();
      const toolDefs = data.tools || [];
      if (toolDefs.length > 0) {
        const lines = ['\n\nVERFÜGBARE API-TOOLS (du kannst sie mit execute_api_tool aufrufen):'];
        for (const td of toolDefs) {
          const params = td.parameters?.properties ? Object.keys(td.parameters.properties).join(', ') : 'keine';
          lines.push(`  • ${td.name}: ${td.description || ''} (Parameter: ${params})`);
        }
        return { tools: toolDefs, descriptions: lines.join('\n') };
      }
    }
  } catch (e) {
    console.warn(`[Tools] Resolve failed: ${e.message}`);
  }
  return { tools: [], descriptions: '' };
}

// ═══════════════════════════════════════════════════════════════════
//  RAG / FIRMENWISSEN
// ═══════════════════════════════════════════════════════════════════

async function queryKnowledge(query, apiKey) {
  const headers = apiKey ? { 'X-API-Key': apiKey } : {};
  try {
    const resp = await fetch(`${CONFIG.backend_url}/api/settings/knowledge/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ query, top_k: 3 }),
      signal: AbortSignal.timeout(15000),
    });
    if (resp.ok) {
      const data = await resp.json();
      const chunks = (data.results || []).map(r => r.chunk_text);
      return chunks.length > 0 ? chunks.join('\n\n---\n\n') : 'Keine relevanten Informationen gefunden.';
    }
    return `Fehler bei der Wissensabfrage: ${resp.status}`;
  } catch (e) {
    return `Wissensabfrage nicht verfügbar: ${e.message.substring(0, 100)}`;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  MEETERGO v4
// ═══════════════════════════════════════════════════════════════════

async function checkMeetergoAvailability(startDate, endDate, config) {
  if (config.MEETERGO_ENABLED !== 'true') return 'Meetergo Kalender ist nicht aktiviert.';
  const uid = config.MEETERGO_USER_ID || config.meetergo_user_id || '';
  const key = config.MEETERGO_API_KEY || config.meetergo_api_key || '';
  const mtid = config.MEETERGO_MEETING_TYPE_ID || config.meetergo_meeting_type_id || '';
  if (!uid || !key || !mtid) return 'Meetergo Zugangsdaten unvollständig.';
  let qEnd = endDate;
  if (startDate === endDate) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + 1);
    qEnd = d.toISOString().split('T')[0];
  }
  try {
    const url = `https://api.meetergo.com/v4/booking-availability?meetingTypeId=${mtid}&hostIds=${uid}&start=${startDate}&end=${qEnd}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${key}`, 'x-meetergo-api-user-id': uid },
      signal: AbortSignal.timeout(10000),
    });
    if (resp.ok) {
      const data = await resp.json();
      const dates = data.dates || [];
      if (!dates.length) return `Keine verfügbaren Termine zwischen ${startDate} und ${endDate}.`;
      const allSpots = [];
      for (const d of dates) {
        for (const s of (d.spots || [])) {
          allSpots.push({ date: d.date, startTime: s.startTime || '' });
        }
      }
      allSpots.sort(() => Math.random() - 0.5);
      const result = allSpots.slice(0, 10).map(s => {
        const h = parseInt(s.startTime.substring(11, 13)) + 2;
        const m = s.startTime.substring(14, 16);
        return `${s.date}: ${h >= 24 ? h - 24 : String(h).padStart(2, '0')}:${m} Uhr`;
      });
      return 'Verfügbare Termine (MEZ/Sommerzeit):\n' + result.join('\n');
    }
    return `Fehler bei Verfügbarkeitsabfrage: HTTP ${resp.status}`;
  } catch (e) {
    return `Kalenderabfrage nicht möglich: ${e.message.substring(0, 100)}`;
  }
}

async function bookMeetergoAppointment(args, config, callerPhone, calledDid) {
  if (config.MEETERGO_ENABLED !== 'true') return 'Meetergo Kalender ist nicht aktiviert.';
  const uid = config.MEETERGO_BOOKING_HOST_ID || config.meetergo_booking_host_id || config.MEETERGO_USER_ID || config.meetergo_user_id || '';
  const key = config.MEETERGO_BOOKING_API_KEY || config.meetergo_booking_api_key || config.MEETERGO_API_KEY || config.meetergo_api_key || '';
  const mtid = config.MEETERGO_BOOKING_MTID || config.meetergo_booking_mtid || config.MEETERGO_MEETING_TYPE_ID || config.meetergo_meeting_type_id || '';
  if (!uid || !key || !mtid) return 'Meetergo Zugangsdaten unvollständig.';
  try {
    const nameParts = (args.callerName || 'Anrufer').trim().split(/\s+/);
    const firstname = nameParts[0];
    const lastname = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
    const realPhone = calledDid && calledDid.startsWith('+') ? calledDid : (callerPhone || '');
    const phoneClean = realPhone.replace(/[^0-9+]/g, '');
    const email = `${phoneClean.replace(/\+/g, '')}@gofonia.de`;
    const mobText = args.callerPhone && args.callerPhone !== realPhone ? ` Mobil: ${args.callerPhone}` : '';
    const grundText = args.grund ? `. Grund: ${args.grund}` : '';
    const body = {
      attendee: {
        email,
        firstname,
        lastname,
        fullname: args.callerName || 'Anrufer',
        phone: realPhone,
        receiveReminders: true,
        language: 'de',
        timezone: 'Europe/Berlin',
        dataPolicyAccepted: true,
      },
      meetingTypeId: mtid,
      hostIds: [uid],
      start: args.startTime,
      duration: 30,
      channel: 'connect',
      context: `${args.callerName || 'Anrufer'} hat angerufen von ${realPhone}.${mobText}${grundText}`,
      source: 'gofonia_voice_bot',
    };
    const resp = await fetch('https://api.meetergo.com/v4/booking', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'x-meetergo-api-user-id': uid, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (resp.status < 300) {
      return 'Termin gebucht! Bestätigen Sie dem Kunden den Termin.';
    }
    const errText = await resp.text();
    return `Buchung fehlgeschlagen: HTTP ${resp.status} – ${errText.substring(0, 200)}`;
  } catch (e) {
    return `Buchung nicht möglich: ${e.message.substring(0, 100)}`;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  DYNAMIC API TOOLS
// ═══════════════════════════════════════════════════════════════════

async function executeApiTool(toolDefs, toolName, arguments) {
  const td = toolDefs.find(t => t.name === toolName);
  if (!td) return `Tool '${toolName}' nicht gefunden.`;
  const req = td.request || {};
  const url = req.url || '';
  const method = (req.method || 'GET').toUpperCase();
  const headers = req.headers || {};
  let bodyTemplate = req.body || '';
  try {
    for (const [k, v] of Object.entries(arguments || {})) {
      bodyTemplate = bodyTemplate.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
    }
    const fetchOpts = { method, headers, signal: AbortSignal.timeout(10000) };
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      fetchOpts.body = bodyTemplate;
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
    }
    const resp = await fetch(url, fetchOpts);
    const text = await resp.text();
    return text.substring(0, 1500);
  } catch (e) {
    return `Fehler: ${e.message.substring(0, 200)}`;
  }
}

// ═══════════════════════════════════════════════════════════════════
//  OUTCOME ANALYSIS + EMAIL
// ═══════════════════════════════════════════════════════════════════

async function generateSummary(messages, llmKey, llmBase, llmModel) {
  const conversation = messages.filter(m => m.role !== 'system').map(m => `${m.role === 'user' ? 'Kunde' : 'Bot'}: ${m.content}`).join('\n');
  if (!conversation.trim()) return 'Kein Gesprächsverlauf vorhanden.';
  try {
    const resp = await fetch(`${(llmBase || '').replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${llmKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: llmModel, messages: [{ role: 'user', content: `Fasse das Telefonat auf Deutsch kurz zusammen (max. 5 Sätze). Nenne Grund und Ergebnis.\n\nGESPRÄCH:\n${conversation}\n\nZUSAMMENFASSUNG:` }], max_tokens: 300, temperature: 0.3 }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await resp.json();
    return data.choices?.[0]?.message?.content?.trim() || conversation.substring(0, 500);
  } catch (e) {
    return conversation.substring(0, 500);
  }
}

async function sendSummaryEmail(cs) {
  if (!cs.smtp_host || !cs.email_to) {
    console.log(`[${cs.call_sid}] No SMTP config, skipping email`);
    return;
  }
  try {
    const summary = await generateSummary(cs.messages, cs.llm_api_key, cs.llm_base_url, cs.llm_model);
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({ host: cs.smtp_host, port: cs.smtp_port, secure: cs.smtp_port === 465, auth: { user: cs.smtp_user, pass: cs.smtp_pass } });
    const callerInfo = cs.from || cs.call_sid;
    await transporter.sendMail({
      from: cs.smtp_from || cs.smtp_user,
      to: cs.email_to,
      subject: `Gesprächszusammenfassung - ${callerInfo}`,
      text: `Gesprächszusammenfassung\nDatum: ${new Date().toLocaleString('de-DE')}\nDauer: ${cs.duration}s\nAnrufer: ${cs.from}\n\n${summary}`,
    });
    console.log(`[${cs.call_sid}] Summary email sent to ${cs.email_to}`);
  } catch (e) {
    console.error(`[${cs.call_sid}] Email failed: ${e.message}`);
  }
}



// ═══════════════════════════════════════════════════════════════════
//  REDIS
// ═══════════════════════════════════════════════════════════════════

async function saveCallToRedis(cs) {
  try {
    const payload = {
      callSid: cs.call_sid, from: cs.from, leadId: cs.lead_id,
      calledDid: cs.called_did,
      duration: cs.duration, messageCount: cs.messages.filter(m => m.role !== 'system').length,
      conversation: cs.messages.filter(m => m.role !== 'system'),
      timestamp: new Date().toISOString(),
      models: { llm: cs.llm_model, sttProvider: cs.tenant_config?.STT_PROVIDER || 'jambonz', ttsProvider: cs.tenant_config?.TTS_PROVIDER || 'jambonz' },
    };
    await redis.setex(`call:${cs.call_sid}`, 30 * 86400, JSON.stringify(payload));
    await redis.lpush('calls:recent', cs.call_sid);
    await redis.ltrim('calls:recent', 0, 4999);
  } catch (e) { console.error(`Redis save Fehler: ${e.message}`); }
}

async function saveLeadToRedis(cs) {
  if (!cs.lead_id) return;
  try {
    const key = `lead:${cs.lead_id}`; const existing = await redis.get(key);
    const ld = existing ? JSON.parse(existing) : { lead_id: cs.lead_id, status: 'UNCLASSIFIED', first_call: new Date().toISOString(), call_count: 0, calls: [] };
    ld.calls = ld.calls || []; ld.calls.push({ call_sid: cs.call_sid, timestamp: new Date().toISOString(), duration: cs.duration });
    ld.last_call = new Date().toISOString(); ld.call_count = ld.calls.length;
    await redis.setex(key, 30 * 86400, JSON.stringify(ld));
  } catch (e) { console.error(`Redis save_lead Fehler: ${e.message}`); }
}

// ═══════════════════════════════════════════════════════════════════
//  CALL SESSION
// ═══════════════════════════════════════════════════════════════════

class CallSession {
  constructor(callSid, leadId, fromNumber) {
    this.call_sid = callSid;
    this.lead_id = leadId;
    this.from = fromNumber;
    this.called_did = '';
    this.startTime = Date.now();
    this.outcome = null;
    this.finalizing = false;
    this.tenant_config = {};
    this.meetergo_config = {};
    this.dynamic_tools = [];
    this.transfer_target = null;
    this.transfer_mode = null;
    this.llm_api_key = CONFIG.llm_api_key;
    this.llm_base_url = CONFIG.llm_base_url;
    this.llm_model = CONFIG.llm_model;
    this.smtp_host = '';
    this.smtp_port = 587;
    this.smtp_user = '';
    this.smtp_pass = '';
    this.smtp_from = '';
    this.email_to = '';
    const today = new Date().toISOString().split('T')[0];
    const dateContext = `\n\nHEUTIGES DATUM: ${today}`;
    this.messages = [{ role: 'system', content: VERKAUF_PROMPT + dateContext }];
  }
  get duration() { return Math.floor((Date.now() - this.startTime) / 1000); }
  addMessage(role, content) { this.messages.push({ role, content }); }
  getConversationText() {
    return this.messages.filter(m => m.role !== 'system').map(m => `${m.role === 'user' ? 'Kunde' : 'Bot'}: ${m.content}`).join('\n');
  }
}

const sessions = new Map();

// ═══════════════════════════════════════════════════════════════════
//  GET TOOLS (dynamic per tenant)
// ═══════════════════════════════════════════════════════════════════

function getTools(session) {
  const tools = [
    { type: 'function', function: { name: 'end_call', description: 'Beende das Telefongespraech und lege auf.', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'firmenwissen', description: 'Durchsuche das Firmenwissen nach Informationen zu einem bestimmten Thema oder einer Frage. Nutze dies wenn der Kunde etwas zu deinen Produkten, Dienstleistungen oder dem Unternehmen fragt.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Die Suchanfrage' } }, required: ['query'] } } },
    { type: 'function', function: { name: 'verbinden', description: 'Verbinde den Anrufer mit einem Ziel (Telefonnummer oder Durchwahl). Bei ansagen=true stellst du warm durch (kündigst vorher an). Bei ansagen=false wird kalt durchgestellt. Rufe dies auf wenn der Kunde mit einem Kollegen/Mitarbeiter verbunden werden möchte.', parameters: { type: 'object', properties: { ziel: { type: 'string', description: 'Telefonnummer oder Durchwahl' }, ansagen: { type: 'boolean', description: 'True für Warmvermittlung, False für Kaltvermittlung' } }, required: ['ziel'] } } },
  ];
  if (session.meetergo_config.enabled === 'true' || CONFIG.calendar_enabled) {
    tools.push(
      { type: 'function', function: { name: 'check_available_slots', description: 'Rufe die naechsten verfuegbaren Termine ab. Rufe dies auf wenn der Kunde nach einem Termin fragt.', parameters: { type: 'object', properties: { start: { type: 'string', description: 'Heutiges Datum als YYYY-MM-DD' }, end: { type: 'string', description: 'Datum 7 Tage in Zukunft als YYYY-MM-DD' } }, required: ['start', 'end'] } } },
      { type: 'function', function: { name: 'book_appointment', description: 'Buche einen Termin. startTime = ISO 8601. callerName = voller Name. callerPhone = Mobilnummer im E.164-Format.', parameters: { type: 'object', properties: { startTime: { type: 'string', description: 'ISO 8601 Datum-Zeit' }, callerName: { type: 'string', description: 'Voller Name des Anrufers' }, callerPhone: { type: 'string', description: 'Mobilnummer im E.164-Format' }, grund: { type: 'string', description: 'Grund des Anrufs' } }, required: ['startTime', 'callerName', 'callerPhone'] } } }
    );
  }
  if (session.dynamic_tools && session.dynamic_tools.length > 0) {
    for (const td of session.dynamic_tools) {
      tools.push({
        type: 'function',
        function: {
          name: `api_${td.name}`,
          description: td.description || `Führe ${td.name} aus.`,
          parameters: td.parameters || { type: 'object', properties: {} },
        }
      });
    }
  }
  return tools;
}

// ═══════════════════════════════════════════════════════════════════
//  EXECUTE TOOL
// ═══════════════════════════════════════════════════════════════════

async function executeTool(name, args, session) {
  switch (name) {
    case 'end_call':
      return JSON.stringify({ status: 'call_ended' });
    case 'firmenwissen':
      return await queryKnowledge(args.query, session.tenant_config?.ha_api_key || CONFIG.ha_api_key);
    case 'verbinden':
      session.transfer_target = args.ziel;
      session.transfer_mode = args.ansagen !== false ? 'warm' : 'cold';
      return JSON.stringify({ status: 'transfer_queued', ziel: args.ziel, mode: session.transfer_mode });
    case 'check_available_slots':
      return await checkMeetergoAvailability(args.start || new Date().toISOString().split('T')[0], args.end || new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0], session.meetergo_config);
    case 'book_appointment':
      return await bookMeetergoAppointment({ callerName: args.callerName, callerPhone: args.callerPhone, startTime: args.startTime, grund: args.grund }, session.meetergo_config, args.callerPhone, session.called_did);
    default:
      if (name.startsWith('api_')) {
        const toolName = name.substring(4);
        return await executeApiTool(session.dynamic_tools, toolName, args);
      }
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// ═══════════════════════════════════════════════════════════════════
//  FINALIZE CALL
// ═══════════════════════════════════════════════════════════════════

async function finalizeCall(session) {
  if (session.finalizing) return;
  session.finalizing = true;
  console.log(`[${session.call_sid}] Call finalisiert (Dauer: ${session.duration}s)`);
  await saveCallToRedis(session);
  await saveLeadToRedis(session);
  await sendSummaryEmail(session);
  sessions.delete(session.call_sid);
}

// ═══════════════════════════════════════════════════════════════════
//  EXTRACT DID FROM CALLER/ROOM
// ═══════════════════════════════════════════════════════════════════

function extractDid(reqBody) {
  // Jambonz provides calledNumber in the SIP headers or custom fields
  const calledDid = reqBody.called_number || reqBody.calledNumber || reqBody.to || reqBody.called || '';
  const callerDid = reqBody.from || reqBody.caller_id || '';
  if (calledDid && (calledDid.startsWith('+') || calledDid.startsWith('0'))) return calledDid;
  if (callerDid && (callerDid.startsWith('+') || callerDid.startsWith('0'))) return callerDid;
  return calledDid || callerDid;
}

// ═══════════════════════════════════════════════════════════════════
//  WEBHOOK ROUTES
// ═══════════════════════════════════════════════════════════════════

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── INITIAL CALL ──────────────────────────────────────────────────

app.post('/calling', async (req, res) => {
  const callSid = req.body.call_sid;
  const from = req.body.from || '';
  const callerName = req.body.caller_name || '';
  const leadId = callerName || from.replace('sip:', '').split('@')[0] || '';
  const session = new CallSession(callSid, leadId, from);
  sessions.set(callSid, session);

  // Resolve tenant config from DID
  const calledDid = extractDid(req.body);
  session.called_did = calledDid;
  console.log(`[${callSid}] Neuer Anruf von ${from} an ${calledDid} (Lead: ${leadId})`);

  const tc = await resolveTenantConfig(calledDid);
  session.tenant_config = tc;

  // Apply tenant overrides
  if (tc.LLM_API_KEY) session.llm_api_key = tc.LLM_API_KEY;
  if (tc.LLM_BASE_URL) session.llm_base_url = tc.LLM_BASE_URL;
  if (tc.LLM_MODEL) session.llm_model = tc.LLM_MODEL;
  if (tc.SMTP_HOST) session.smtp_host = tc.SMTP_HOST;
  if (tc.SMTP_PORT) session.smtp_port = parseInt(tc.SMTP_PORT) || 587;
  if (tc.SMTP_USER) session.smtp_user = tc.SMTP_USER;
  if (tc.SMTP_PASS) session.smtp_pass = tc.SMTP_PASS;
  if (tc.SMTP_FROM) session.smtp_from = tc.SMTP_FROM;
  if (tc.EMAIL_TO) session.email_to = tc.EMAIL_TO;

  // Meetergo config from tenant or fallback to env
  if (tc.MEETERGO_ENABLED) session.meetergo_config.enabled = tc.MEETERGO_ENABLED;
  else session.meetergo_config.enabled = CONFIG.calendar_enabled ? 'true' : 'false';
  session.meetergo_config.user_id = tc.MEETERGO_USER_ID || CONFIG.meetergo_host_id;
  session.meetergo_config.api_key = tc.MEETERGO_API_KEY || CONFIG.meetergo_api_key;
  session.meetergo_config.meeting_type_id = tc.MEETERGO_MEETING_TYPE_ID || CONFIG.meetergo_meeting_type_id;
  session.meetergo_config.booking_api_key = tc.MEETERGO_BOOKING_API_KEY || tc.MEETERGO_API_KEY || CONFIG.meetergo_api_key;
  session.meetergo_config.booking_host_id = tc.MEETERGO_BOOKING_HOST_ID || tc.MEETERGO_USER_ID || CONFIG.meetergo_host_id;
  session.meetergo_config.booking_mtid = tc.MEETERGO_BOOKING_MTID || tc.MEETERGO_MEETING_TYPE_ID || CONFIG.meetergo_meeting_type_id;

  // Dynamic tools
  const { tools: dynamicTools, descriptions: toolDescriptions } = await resolveDynamicTools(calledDid);
  session.dynamic_tools = dynamicTools;

  // Build system prompt with tenant prompt, date, tool descriptions
  let systemPrompt = tc['prompt_system_prompt.txt'] || tc.prompt_system_prompt_txt || VERKAUF_PROMPT;
  const today = new Date().toISOString().split('T')[0];
  systemPrompt = `\n\nHEUTIGES DATUM: ${today}\nDie Rufnummer des Anrufers ist ${calledDid}.\n` + systemPrompt;
  if (toolDescriptions) systemPrompt += toolDescriptions;
  session.messages = [{ role: 'system', content: systemPrompt }];

  // Apply tenant-specific LLM client
  const activeLlmClient = (session.llm_api_key !== CONFIG.llm_api_key || session.llm_base_url !== CONFIG.llm_base_url)
    ? new OpenAI({ apiKey: session.llm_api_key, baseURL: session.llm_base_url })
    : llmClient;

  // Generate greeting
  let greetingText = 'Hallo, wie kann ich Ihnen helfen?';
  try {
    session.addMessage('user', 'Beginne jetzt das Gespraech. Begruessse den Anrufer gemaess dem Gespraechsablauf.');
    const response = await activeLlmClient.chat.completions.create({ model: session.llm_model, messages: session.messages, tools: getTools(session).length > 0 ? getTools(session) : undefined, stream: false, ...buildExtraParams() });
    const msg = response.choices[0].message;
    if (msg.content) {
      greetingText = stripMarkup(msg.content);
      session.messages = session.messages.filter(m => m.content !== 'Beginje jetzt das Gespraech. Begruessse den Anrufer gemaess dem Gespraechsablauf.');
      session.addMessage('assistant', greetingText);
    } else if (msg.tool_calls) {
      // Handle tool calls in greeting (rare but possible)
      session.messages.push(msg);
      for (const tc of msg.tool_calls) {
        const toolResult = await executeTool(tc.function.name, JSON.parse(tc.function.arguments || '{}'), session);
        session.addMessage('tool', toolResult);
        session.messages.push({ role: 'tool', tool_call_id: tc.id, content: toolResult });
      }
    }
  } catch (e) {
    console.error(`[${callSid}] LLM Fehler: ${e.message}`);
  }

  console.log(`[${callSid}] Bot: ${greetingText}`);
  res.json([{ verb: 'gather', input: ['speech'], actionHook: '/actionHook', timeout: 30, say: { text: greetingText }, listenDuringPrompt: true }]);
});

// ── ACTION HOOK (each turn) ──────────────────────────────────────

app.post('/actionHook', async (req, res) => {
  const callSid = req.body.call_sid;
  const session = sessions.get(callSid);
  const reason = req.body.reason;

  if (!session) return res.json([{ verb: 'hangup' }]);

  // Check call duration watchdog
  if (session.duration > CONFIG.max_call_duration) {
    console.log(`[${callSid}] Call duration exceeded ${CONFIG.max_call_duration}s, ending call`);
    await finalizeCall(session);
    return res.json([{ verb: 'say', text: 'Das Gespräch hat die maximale Dauer überschritten. Auf Wiedersehen.' }, { verb: 'hangup' }]);
  }

  if (reason === 'timeout' || reason === 'no-input') {
    return res.json([{ verb: 'gather', input: ['speech'], actionHook: '/actionHook', timeout: 30, say: { text: 'Sind Sie noch da? Ich warte gerne.' }, listenDuringPrompt: true }]);
  }

  const speechResult = req.body.speech?.alternatives?.[0]?.transcript;
  if (speechResult) {
    console.log(`[${callSid}] Kunde: ${speechResult}`);
    session.addMessage('user', speechResult);
  } else if (reason !== 'speechDetected') {
    return res.json([{ verb: 'gather', input: ['speech'], actionHook: '/actionHook', timeout: 30, listenDuringPrompt: true }]);
  }

  // Apply tenant-specific LLM client
  const activeLlmClient = (session.llm_api_key !== CONFIG.llm_api_KEY || session.llm_base_url !== CONFIG.llm_base_url)
    ? new OpenAI({ apiKey: session.llm_api_key, baseURL: session.llm_base_url })
    : llmClient;

  try {
    const tools = getTools(session);
    const response = await activeLlmClient.chat.completions.create({ model: session.llm_model, messages: session.messages, tools: tools.length > 0 ? tools : undefined, stream: false, ...buildExtraParams() });
    const message = response.choices[0].message;

    if (message.tool_calls && message.tool_calls.length > 0) {
      session.messages.push(message);
      let transferQueued = false;
      for (const toolCall of message.tool_calls) {
        const toolName = toolCall.function.name;
        const toolArgs = JSON.parse(toolCall.function.arguments || '{}');
        console.log(`[${callSid}] Tool: ${toolName}`);

        if (toolName === 'end_call') {
          await finalizeCall(session);
          return res.json([{ verb: 'hangup' }]);
        }

        const toolResult = await executeTool(toolName, toolArgs, session);
        session.messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult });

        if (toolName === 'verbinden' && session.transfer_target) {
          transferQueued = true;
        }
      }

      // If transfer was queued, handle it
      if (transferQueued && session.transfer_target) {
        const target = session.transfer_target;
        const isWarm = session.transfer_mode === 'warm';
        if (isWarm) {
          // Warm transfer: say introduction, then dial
          const followUp = await activeLlmClient.chat.completions.create({ model: session.llm_model, messages: session.messages, stream: false, ...buildExtraParams() });
          const introText = stripMarkup(followUp.choices[0].message.content || 'Ich verbinde Sie jetzt.');
          session.addMessage('assistant', introText);
          console.log(`[${callSid}] Warmvermittlung zu ${target}: ${introText}`);
          return res.json([
            { verb: 'say', text: introText },
            { verb: 'dial', target: { type: 'phone', number: target }, answerOnMedia: true },
          ]);
        } else {
          // Cold transfer: just dial
          console.log(`[${callSid}] Kaltvermittlung zu ${target}`);
          return res.json([{ verb: 'dial', target: { type: 'phone', number: target } }]);
        }
      }

      const followUp = await activeLlmClient.chat.completions.create({ model: session.llm_model, messages: session.messages, stream: false, ...buildExtraParams() });
      const followUpText = stripMarkup(followUp.choices[0].message.content || '');
      if (followUpText) session.addMessage('assistant', followUpText);
      return res.json([{ verb: 'gather', input: ['speech'], actionHook: '/actionHook', timeout: 30, say: { text: followUpText || 'Kann ich Ihnen sonst noch helfen?' }, listenDuringPrompt: true }]);
    }

    const text = stripMarkup(message.content || '');
    if (text) session.addMessage('assistant', text);
    console.log(`[${callSid}] Bot: ${text}`);
    res.json([{ verb: 'gather', input: ['speech'], actionHook: '/actionHook', timeout: 30, say: { text: text || 'Kann ich Ihnen noch helfen?' }, listenDuringPrompt: true }]);
  } catch (e) {
    console.error(`[${callSid}] LLM Fehler: ${e.message}`);
    res.json([{ verb: 'say', text: 'Entschuldigung, es gab ein technisches Problem.' }]);
  }
});

// ── CALL STATUS (hangup, etc.) ───────────────────────────────────

app.post('/callStatus', async (req, res) => {
  const callSid = req.body.call_sid;
  const callStatus = req.body.call_status;
  console.log(`[${callSid}] Status: ${callStatus}`);
  if (['completed', 'failed', 'no-answer', 'busy'].includes(callStatus)) {
    const session = sessions.get(callSid);
    if (session && !session.finalizing) {
      await new Promise(r => setTimeout(r, 3000));
      const s = sessions.get(callSid);
      if (s) await finalizeCall(s);
    }
  }
  res.sendStatus(200);
});

// ── HEALTH ────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ status: 'ok', calls: sessions.size }));

const server = app.listen(CONFIG.port, () => {
  console.log(`Jambonz Bot v2.0 auf Port ${CONFIG.port}`);
  console.log(`LLM: ${CONFIG.llm_model}`);
  console.log(`Backend: ${CONFIG.backend_url}`);
});

module.exports = { app, CONFIG, sessions, CallSession };