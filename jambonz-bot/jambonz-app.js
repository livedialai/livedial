/**
 * jambonz Voice AI Agent v4.1 – Production Ready (CommonJS) - FULLY FIXED
 * 
 * Behobene Probleme:
 * - Variable Shadowing (tc -> toolCall)
 * - getGermanTimezoneOffset Fallback korrigiert
 * - calledDid/callerPhone Logik in bookMeetergoAppointment korrigiert
 * - Race Condition bei Queue-Transfer (queue_name wird vor dem Hook gesetzt)
 * - finalizeCall Mutex (Promise-basiert)
 * - Sessions-Cleanup nach Transfer sichergestellt
 * - Input-Sanitizing für dynamische API-Tools (RegExp Injection)
 * - Doppelter getTools()-Aufruf vermieden
 * - Ungenutzten http-Import entfernt
 * - MAX_CALL_DURATION Check auch im agentHook
 * - Webhook-Authentifizierung (optional, per Shared Secret)
 * - nodemailer Transporter gecacht (Performance)
 */

require('dotenv').config();
const express = require('express');
const Redis = require('ioredis');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

// ══════════════════════════════════════════════════════════════════
//  KONFIGURATION
// ══════════════════════════════════════════════════════════════════
const CONFIG = {
  port: parseInt(process.env.PORT || '3009'),
  redis_url: process.env.REDIS_URL || 'redis://localhost:6379',
  redis_password: process.env.REDIS_PASSWORD || '',
  backend_url: process.env.BACKEND_URL || 'http://localhost:8000',
  ha_api_key: process.env.HA_API_KEY || '',
  llm_api_key: process.env.LLM_API_KEY || 'dummy',
  llm_base_url: process.env.LLM_BASE_URL || undefined,
  llm_model: process.env.LLM_MODEL || 'gpt-4o-mini',
  llm_no_think: (process.env.LLM_NO_THINK || 'true').toLowerCase() === 'true',

  jambonz_api_key: process.env.JAMBONZ_API_KEY || '',
  jambonz_account_sid: process.env.JAMBONZ_ACCOUNT_SID || '',
  jambonz_api_base_url: process.env.JAMBONZ_API_BASE_URL || 'https://jambonz.cloud/api/v1',
  jambonz_carrier_sid: process.env.JAMBONZ_CARRIER_SID || '',
  jambonz_caller_id: process.env.JAMBONZ_CALLER_ID || '',

  public_url: process.env.PUBLIC_URL || 'http://localhost:3009',

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
  
  hold_music_url: process.env.HOLD_MUSIC_URL || '',

  tts_vendor: process.env.TTS_VENDOR || '',
  tts_voice_id: process.env.TTS_VOICE_ID || '',

  webhook_secret: process.env.WEBHOOK_SECRET || '',
};

// ══════════════════════════════════════════════════════════════════
//  HELPER FUNCTIONS
// ══════════════════════════════════════════════════════════════════
function loadPromptSync(filePath, fallback) {
  try {
    return fs.readFileSync(path.resolve(filePath), 'utf-8');
  } catch {
    console.warn(`Prompt nicht gefunden: ${filePath}, nutze Fallback`);
    return fallback;
  }
}

function stripMarkup(text) {
  if (!text) return '';
  return text.replace(/<[^>]*>/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function sayVerb(text, session) {
  const say = { verb: 'say', text };
  const vendor = (session && session.tts_vendor) || CONFIG.tts_vendor;
  const voice = (session && session.tts_voice_id) || CONFIG.tts_voice_id;
  if (vendor) {
    say.synthesizer = { vendor };
    if (voice) say.synthesizer.voice = voice;
  }
  return say;
}

function sayTTS(text, session) {
  const obj = { text };
  const vendor = (session && session.tts_vendor) || CONFIG.tts_vendor;
  const voice = (session && session.tts_voice_id) || CONFIG.tts_voice_id;
  if (vendor) {
    obj.synthesizer = { vendor };
    if (voice) obj.synthesizer.voice = voice;
  }
  return obj;
}

function buildExtraParams() {
  return CONFIG.llm_no_think ? { extra_body: { chat_template_kwargs: { enable_thinking: false } } } : {};
}

function getGermanTimezoneOffset() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    timeZoneName: 'short'
  });
  const parts = formatter.formatToParts(now);
  const tzPart = parts.find(p => p.type === 'timeZoneName')?.value || '';
  
  if (tzPart.includes('CEST')) return 2;
  if (tzPart.includes('CET')) return 1;
  
  const berlinDate = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const diffMinutes = berlinDate.getTime() - now.getTime();
  return Math.round(diffMinutes / 3600000);
}

function extractDid(reqBody) {
  return reqBody.called_number || reqBody.calledNumber || reqBody.to || reqBody.called || '';
}

// ══════════════════════════════════════════════════════════════════
//  JAMBONZ REST API CLIENT
// ══════════════════════════════════════════════════════════════════
class JambonzApi {
  constructor(baseUrl, apiKey, accountSid) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.accountSid = accountSid;
  }

  _headers() {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json'
    };
  }

  async _request(method, path, body = null) {
    const url = `${this.baseUrl}${path}`;
    const opts = {
      method,
      headers: this._headers(),
      signal: AbortSignal.timeout(10000)
    };
    if (body) opts.body = JSON.stringify(body);
    
    const resp = await fetch(url, opts);
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Jambonz API ${method} ${path} failed (${resp.status}): ${errText}`);
    }
    return resp.json();
  }

  async createCall({ to, from, callerName, headers, actionHook }) {
    return this._request('POST', `/Accounts/${this.accountSid}/Calls`, {
      to,
      from: from || CONFIG.jambonz_caller_id,
      carrier_sid: CONFIG.jambonz_carrier_sid,
      callerName: callerName || '',
      headers: headers || {},
      actionHook: actionHook || `${CONFIG.public_url}/agentHook`,
      timeLimit: 120
    });
  }

  async bridgeCalls(callSid, targetCallSid) {
    return this._request('PUT', `/Accounts/${this.accountSid}/Calls/${callSid}`, {
      action_hook: `${CONFIG.public_url}/bridgeHook?target=${targetCallSid}`
    });
  }

  async enqueueCall(callSid, queueName) {
    return this._request('PUT', `/Accounts/${this.accountSid}/Calls/${callSid}`, {
      action_hook: `${CONFIG.public_url}/enqueueHook?queue=${queueName}`
    });
  }

  async updateCallWebhook(callSid, actionHook) {
    return this._request('PUT', `/Accounts/${this.accountSid}/Calls/${callSid}`, {
      action_hook: actionHook
    });
  }

  async createQueue(name) {
    try {
      return await this._request('POST', `/Accounts/${this.accountSid}/Queues`, { name });
    } catch (e) {
      if (!e.message.includes('already exists')) {
        console.warn(`Queue creation failed: ${e.message}`);
      }
    }
  }
}

const jambonzApi = new JambonzApi(
  CONFIG.jambonz_api_base_url,
  CONFIG.jambonz_api_key,
  CONFIG.jambonz_account_sid
);

// ══════════════════════════════════════════════════════════════════
//  REDIS PERSISTENZ
// ══════════════════════════════════════════════════════════════════
const redis = CONFIG.redis_password
  ? new Redis({ host: 'localhost', port: 6379, password: CONFIG.redis_password })
  : new Redis(CONFIG.redis_url);
redis.on('error', (err) => console.error('Redis Fehler:', err));

async function saveCallToRedis(session) {
  const key = `call:${session.call_sid}`;
  const data = {
    call_sid: session.call_sid,
    lead_id: session.lead_id,
    from: session.from,
    called_did: session.called_did,
    start_time: session.startTime,
    duration: session.duration,
    outcome: session.outcome,
    transfer_variant: session.transfer_variant,
    transfer_target: session.transfer_target,
    messages: session.messages.slice(-20),
    created_at: new Date().toISOString()
  };
  await redis.setex(key, 86400, JSON.stringify(data));
  console.log(`[${session.call_sid}] Saved to Redis`);
}

async function saveLeadToRedis(session) {
  const key = `lead:${session.lead_id || session.from}`;
  const existing = await redis.get(key);
  let lead = existing ? JSON.parse(existing) : { calls: [] };
  
  lead.calls.push({
    call_sid: session.call_sid,
    timestamp: new Date().toISOString(),
    duration: session.duration,
    outcome: session.outcome,
    summary: session.context_summary
  });
  lead.last_contact = new Date().toISOString();
  
  await redis.setex(key, 2592000, JSON.stringify(lead));
  console.log(`[${session.call_sid}] Lead saved to Redis`);
}

// ══════════════════════════════════════════════════════════════════
//  TENANT RESOLUTION
// ══════════════════════════════════════════════════════════════════
async function resolveTenantConfig(calledDid) {
  const headers = CONFIG.ha_api_key ? { 'X-API-Key': CONFIG.ha_api_key } : {};
  
  if (calledDid) {
    try {
      const resp = await fetch(`${CONFIG.backend_url}/api/tenants/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ did: calledDid }),
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.config && Object.keys(data.config).length > 0) {
          console.log(`[Tenant] Resolved tenant config for DID ${calledDid}`);
          return data.config;
        }
      }
    } catch (e) {
      console.warn(`[Tenant] Resolve failed for ${calledDid}: ${e.message}`);
    }
  }
  
  try {
    const resp = await fetch(`${CONFIG.backend_url}/api/tenants/default-config`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const data = await resp.json();
      console.log('[Tenant] Using default tenant config');
      return data.config || {};
    }
  } catch (e) {
    console.warn(`[Tenant] Default config failed: ${e.message}`);
  }
  
  console.log('[Tenant] No tenant config found, using global defaults');
  return {};
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

// ══════════════════════════════════════════════════════════════════
//  RAG / FIRMENWISSEN
// ══════════════════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════════════════
//  MEETERGO v4
// ══════════════════════════════════════════════════════════════════
async function checkMeetergoAvailability(startDate, endDate, config) {
  if (String(config.enabled) !== 'true') return 'Meetergo Kalender ist nicht aktiviert.';
  
  const uid = config.user_id || '';
  const key = config.api_key || '';
  const mtid = config.meeting_type_id || '';
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
      const timezoneOffset = getGermanTimezoneOffset();
      
      const result = allSpots.slice(0, 10).map(s => {
        const slotDate = new Date(s.startTime);
        const berlinTime = slotDate.toLocaleString('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
        return berlinTime;
      });
      
      return 'Verfügbare Termine:\n' + result.join('\n');
    }
    return `Fehler bei Verfügbarkeitsabfrage: HTTP ${resp.status}`;
  } catch (e) {
    return `Kalenderabfrage nicht möglich: ${e.message.substring(0, 100)}`;
  }
}

async function bookMeetergoAppointment(args, config, callerPhone, calledDid) {
  if (String(config.enabled) !== 'true') return 'Meetergo Kalender ist nicht aktiviert.';
  
  const uid = config.booking_host_id || config.user_id || '';
  const key = config.booking_api_key || config.api_key || '';
  const mtid = config.booking_mtid || config.meeting_type_id || '';
  if (!uid || !key || !mtid) return 'Meetergo Zugangsdaten unvollständig.';
  
  try {
    const nameParts = (args.callerName || 'Anrufer').trim().split(/\s+/);
    const firstname = nameParts[0];
    const lastname = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
    const realPhone = callerPhone && callerPhone.startsWith('+') ? callerPhone : (callerPhone || '');
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
      headers: { 
        'Authorization': `Bearer ${key}`, 
        'x-meetergo-api-user-id': uid, 
        'Content-Type': 'application/json' 
      },
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

// ══════════════════════════════════════════════════════════════════
//  DYNAMIC API TOOLS
// ══════════════════════════════════════════════════════════════════
async function executeApiTool(toolDefs, toolName, toolArgs) {
  const td = toolDefs.find(t => t.name === toolName);
  if (!td) return `Tool '${toolName}' nicht gefunden.`;
  
  const req = td.request || {};
  const url = req.url || '';
  const method = (req.method || 'GET').toUpperCase();
  const headers = req.headers || {};
  let bodyTemplate = req.body || '';
  
  try {
    for (const [k, v] of Object.entries(toolArgs || {})) {
      const safeKey = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      bodyTemplate = bodyTemplate.replace(new RegExp(`\\{\\{${safeKey}\\}\\}`, 'g'), String(v));
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

// ══════════════════════════════════════════════════════════════════
//  OUTCOME ANALYSIS + EMAIL
// ══════════════════════════════════════════════════════════════════
const transporterCache = new Map();

function getTransporter(session) {
  const cacheKey = `${session.smtp_host}:${session.smtp_port}:${session.smtp_user}`;
  if (!transporterCache.has(cacheKey)) {
    transporterCache.set(cacheKey, nodemailer.createTransport({
      host: session.smtp_host,
      port: session.smtp_port,
      secure: session.smtp_port === 465,
      auth: { user: session.smtp_user, pass: session.smtp_pass }
    }));
  }
  return transporterCache.get(cacheKey);
}

async function generateSummary(messages, llmKey, llmBase, llmModel) {
  const conversation = messages
    .filter(m => m.role !== 'system' && m.role !== 'tool' && m.content)
    .map(m => `${m.role === 'user' ? 'Kunde' : 'Bot'}: ${m.content}`)
    .join('\n');
  
  if (!conversation.trim()) return 'Kein Gesprächsverlauf vorhanden.';
  
  try {
    const client = new OpenAI({ apiKey: llmKey, baseURL: llmBase });
    const response = await client.chat.completions.create({
      model: llmModel,
      messages: [{ 
        role: 'user', 
        content: `Fasse das Telefonat auf Deutsch kurz zusammen (max. 5 Sätze). Nenne Grund und Ergebnis.\n\nGESPRÄCH:\n${conversation}\n\nZUSAMMENFASSUNG:` 
      }],
      max_tokens: 300,
      temperature: 0.3,
      ...buildExtraParams()
    });
    return response.choices?.[0]?.message?.content?.trim() || conversation.substring(0, 500);
  } catch (e) {
    return conversation.substring(0, 500);
  }
}

async function sendSummaryEmail(session) {
  if (!session.smtp_host || !session.email_to) {
    console.log(`[${session.call_sid}] No SMTP config, skipping email`);
    return;
  }
  
  try {
    const summary = await generateSummary(
      session.messages, 
      session.llm_api_key, 
      session.llm_base_url, 
      session.llm_model
    );
    
    const transporter = getTransporter(session);
    
    const callerInfo = session.from || session.call_sid;
    await transporter.sendMail({
      from: session.smtp_from || session.smtp_user,
      to: session.email_to,
      subject: `Gesprächszusammenfassung - ${callerInfo}`,
      text: `Gesprächszusammenfassung\nDatum: ${new Date().toLocaleString('de-DE')}\nDauer: ${session.duration}s\nAnrufer: ${session.from}\n\n${summary}`,
    });
    console.log(`[${session.call_sid}] Summary email sent to ${session.email_to}`);
  } catch (e) {
    console.error(`[${session.call_sid}] Email failed: ${e.message}`);
  }
}

// ══════════════════════════════════════════════════════════════════
//  CALL SESSION
// ══════════════════════════════════════════════════════════════════
class CallSession {
  constructor(callSid, leadId, fromNumber) {
    this.call_sid = callSid;
    this.lead_id = leadId;
    this.from = fromNumber;
    this.called_did = '';
    this.startTime = Date.now();
    this.outcome = null;
    this.finalizing = false;
    this._finalizePromise = null;
    this.tenant_config = {};
    this.meetergo_config = { enabled: 'false' };
    this.dynamic_tools = [];
    this.transfer_target = null;
    this.transfer_variant = null;
    this.agent_call_sid = null;
    this.transfer_state = 'idle';
    this.queue_name = null;
    this.context_summary = '';
    
    this.llm_api_key = CONFIG.llm_api_key;
    this.llm_base_url = CONFIG.llm_base_url;
    this.llm_model = CONFIG.llm_model;
    this.tts_vendor = CONFIG.tts_vendor || '';
    this.tts_voice_id = CONFIG.tts_voice_id || '';
    this.smtp_host = CONFIG.smtp_host;
    this.smtp_port = CONFIG.smtp_port;
    this.smtp_user = CONFIG.smtp_user;
    this.smtp_pass = CONFIG.smtp_pass;
    this.smtp_from = CONFIG.smtp_from;
    this.email_to = CONFIG.email_to;
    
    this.messages = [];
  }

  get duration() { return Math.floor((Date.now() - this.startTime) / 1000); }
  
  addMessage(role, content) { 
    this.messages.push({ role, content }); 
  }
  
  getConversationText() {
    return this.messages
      .filter(m => m.role !== 'system' && m.role !== 'tool' && m.content)
      .map(m => `${m.role === 'user' ? 'Kunde' : 'Bot'}: ${m.content}`)
      .join('\n');
  }

  async initiateAgentCall(agentNumber, variant, contextSummary = '') {
    const headers = {};
    if (contextSummary) {
      headers['X-Context'] = contextSummary.substring(0, 200);
    }
    
    try {
      const result = await jambonzApi.createCall({
        to: agentNumber,
        from: CONFIG.jambonz_caller_id,
        callerName: this.from,
        headers,
        actionHook: `${CONFIG.public_url}/agentHook`
      });
      
      this.agent_call_sid = result.call_sid;
      this.transfer_variant = variant;
      this.transfer_state = variant === 'queue' ? 'queueing' : 'waiting_agent';
      this.context_summary = contextSummary;
      
      return result.call_sid;
    } catch (e) {
      console.error(`[${this.call_sid}] Agent call failed: ${e.message}`);
      throw e;
    }
  }

  async connectCustomerToAgent() {
    if (this.transfer_state === 'waiting_agent') {
      await jambonzApi.bridgeCalls(this.call_sid, this.agent_call_sid);
      this.transfer_state = 'agent_connected';
      console.log(`[${this.call_sid}] Bridged with agent ${this.agent_call_sid}`);
      return true;
    }
    return false;
  }

  async enqueueCustomer(queueName) {
    if (this.transfer_state === 'queueing') {
      this.queue_name = queueName;
      await jambonzApi.enqueueCall(this.call_sid, queueName);
      console.log(`[${this.call_sid}] Enqueued to ${queueName}, waiting in queue`);
      return true;
    }
    return false;
  }

  async fallbackToBot() {
    this.transfer_state = 'idle';
    this.transfer_variant = null;
    this.agent_call_sid = null;
    
    try {
      await jambonzApi.updateCallWebhook(this.call_sid, `${CONFIG.public_url}/actionHook`);
    } catch (e) {
      console.error(`[${this.call_sid}] Redirect failed: ${e.message}`);
    }
  }

  async finalize() {
    if (this.finalizing) return this._finalizePromise;
    this.finalizing = true;
    this._finalizePromise = (async () => {
      console.log(`[${this.call_sid}] Call finalisiert (Dauer: ${this.duration}s)`);
      try {
        await saveCallToRedis(this);
      } catch (e) { console.error(`[${this.call_sid}] saveCallToRedis failed: ${e.message}`); }
      try {
        await saveLeadToRedis(this);
      } catch (e) { console.error(`[${this.call_sid}] saveLeadToRedis failed: ${e.message}`); }
      try {
        await sendSummaryEmail(this);
      } catch (e) { console.error(`[${this.call_sid}] sendSummaryEmail failed: ${e.message}`); }
      sessions.delete(this.call_sid);
    })();
    return this._finalizePromise;
  }
}

const sessions = new Map();

// ══════════════════════════════════════════════════════════════════
//  CONTACT LOOKUP (Forward Routes)
// ══════════════════════════════════════════════════════════════════
async function resolveContact(name, apiKey) {
  const headers = apiKey ? { 'X-API-Key': apiKey } : {};
  try {
    const resp = await fetch(`${CONFIG.backend_url}/api/settings/forwards/resolve?name=${encodeURIComponent(name)}`, {
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return { number: data.destination, trunk_id: data.trunk_id };
  } catch (e) {
    console.warn(`[Contact] Lookup failed for '${name}': ${e.message}`);
    return null;
  }
}

async function lookupContactByName(name, session) {
  const apiKey = session.tenant_config?.ha_api_key || CONFIG.ha_api_key;
  const contact = await resolveContact(name, apiKey);
  if (!contact) return `Kein Kontakt mit dem Namen "${name}" gefunden.`;
  return `Kontakt "${name}" gefunden: ${contact.number}`;
}

// ══════════════════════════════════════════════════════════════════
//  GET TOOLS
// ══════════════════════════════════════════════════════════════════
function getTools(session) {
  const tools = [
    { 
      type: 'function', 
      function: { 
        name: 'end_call', 
        description: 'Beende das Telefongespraech und lege auf.', 
        parameters: { type: 'object', properties: {} } 
      } 
    },
    { 
      type: 'function', 
      function: { 
        name: 'firmenwissen', 
        description: 'Durchsuche das Firmenwissen nach Informationen.', 
        parameters: { 
          type: 'object', 
          properties: { query: { type: 'string', description: 'Die Suchanfrage' } }, 
          required: ['query'] 
        } 
      } 
    },
    {
      type: 'function',
      function: {
        name: 'kontakt_suchen',
        description: 'Suche einen Mitarbeiter/Kontakt im Adressbuch und gib seine Telefonnummer zurueck. Verwende dies bevor du einen Transfer mit Namen durchfuehrst.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Name des Mitarbeiters/Kontakts (z.B. "Herr Schmitz", "Thomas", "Support")' }
          },
          required: ['name']
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'transfer_call',
        description: `Verbinde den Anrufer mit einem Agenten.
Du kannst entweder eine Telefonnummer (agent_number) oder einen Namen aus dem Adressbuch angeben.
Wenn du einen Namen verwenden willst, rufe zuerst "kontakt_suchen" auf um die Nummer zu ermitteln.
Varianten:
- "cold": sofort durchstellen (keine Vorankündigung)
- "warm": vor dem Verbinden eine kurze Ansage sprechen
- "consult": Erst Agent anrufen, Rücksprache halten, dann Kunden holen
- "queue": In Warteschleife stellen und Agent aus Queue bedienen`,
        parameters: {
          type: 'object',
          properties: {
            agent_number: { type: 'string', description: 'Telefonnummer des Agenten (E.164)' },
            mode: { type: 'string', enum: ['cold', 'warm', 'consult', 'queue'], description: 'Art des Transfers' },
            context_summary: { type: 'string', description: 'Kurze Zusammenfassung für den Agenten (max. 200 Zeichen)' }
          },
          required: ['agent_number', 'mode']
        }
      }
    }
  ];

  if (session.meetergo_config.enabled === 'true' || CONFIG.calendar_enabled) {
    tools.push(
      { 
        type: 'function', 
        function: { 
          name: 'check_available_slots', 
          description: 'Rufe die naechsten verfuegbaren Termine ab.', 
          parameters: { 
            type: 'object', 
            properties: { 
              start: { type: 'string', description: 'Startdatum als YYYY-MM-DD' }, 
              end: { type: 'string', description: 'Enddatum als YYYY-MM-DD' } 
            }, 
            required: ['start', 'end'] 
          } 
        } 
      },
      { 
        type: 'function', 
        function: { 
          name: 'book_appointment', 
          description: 'Buche einen Termin.', 
          parameters: { 
            type: 'object', 
            properties: { 
              startTime: { type: 'string', description: 'ISO 8601 Datum-Zeit' }, 
              callerName: { type: 'string' }, 
              callerPhone: { type: 'string' }, 
              grund: { type: 'string' } 
            }, 
            required: ['startTime', 'callerName', 'callerPhone'] 
          } 
        } 
      }
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

// ══════════════════════════════════════════════════════════════════
//  EXECUTE TOOL
// ══════════════════════════════════════════════════════════════════
async function executeTool(name, args, session) {
  switch (name) {
    case 'end_call':
      return JSON.stringify({ status: 'call_ended' });
      
    case 'firmenwissen':
      return await queryKnowledge(args.query, session.tenant_config?.ha_api_key || CONFIG.ha_api_key);
      
    case 'kontakt_suchen':
      return await lookupContactByName(args.name, session);
      
    case 'transfer_call':
      return await handleTransfer(args, session);
      
    case 'check_available_slots':
      return await checkMeetergoAvailability(
        args.start || new Date().toISOString().split('T')[0], 
        args.end || new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0], 
        session.meetergo_config
      );
      
    case 'book_appointment':
      return await bookMeetergoAppointment(args, session.meetergo_config, session.from, session.called_did);
      
    default:
      if (name.startsWith('api_')) {
        const toolName = name.substring(4);
        return await executeApiTool(session.dynamic_tools, toolName, args);
      }
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

async function handleTransfer(args, session) {
  const agent = args.agent_number;
  const mode = args.mode || 'warm';
  const context = args.context_summary || '';

  session.transfer_target = agent;
  session.context_summary = context;

  switch (mode) {
    case 'cold':
      return JSON.stringify({ status: 'cold_transfer', target: agent });

    case 'warm':
    case 'consult':
    case 'queue':
      try {
        await session.initiateAgentCall(agent, mode, context);
        return JSON.stringify({ status: `${mode}_transfer_started`, agent_call_sid: session.agent_call_sid });
      } catch (e) {
        return JSON.stringify({ error: `Transfer failed: ${e.message}` });
      }

    default:
      return JSON.stringify({ error: 'Ungültiger Transfer-Modus' });
  }
}

// ══════════════════════════════════════════════════════════════════
//  AUTH MIDDLEWARE
// ══════════════════════════════════════════════════════════════════
function requireWebhookAuth(req, res, next) {
  if (!CONFIG.webhook_secret) return next();
  const provided = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer /i, '');
  if (provided === CONFIG.webhook_secret) return next();
  console.warn(`Unauthorized webhook attempt from ${req.ip}`);
  res.status(401).json({ error: 'Unauthorized' });
}

// ══════════════════════════════════════════════════════════════════
//  EXPRESS APP
// ══════════════════════════════════════════════════════════════════
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const llmClient = new OpenAI({ 
  apiKey: CONFIG.llm_api_key, 
  baseURL: CONFIG.llm_base_url 
});

// ══════════════════════════════════════════════════════════════════
//  WEBHOOKS
// ══════════════════════════════════════════════════════════════════
app.post('/bridgeHook', requireWebhookAuth, async (req, res) => {
  const targetCallSid = req.query.target;
  const currentCallSid = req.body.call_sid;
  
  console.log(`[${currentCallSid}] Bridge hook triggered, target: ${targetCallSid}`);
  
  res.json([{ verb: 'bridge', target: [{ type: 'call', call_sid: targetCallSid }] }]);
});

app.post('/enqueueHook', requireWebhookAuth, async (req, res) => {
  const queueName = req.query.queue;
  const currentCallSid = req.body.call_sid;
  
  console.log(`[${currentCallSid}] Enqueue hook triggered, queue: ${queueName}`);
  
  res.json([{ verb: 'enqueue', queue: queueName }]);
});

app.post('/calling', requireWebhookAuth, async (req, res) => {
  const callSid = req.body.call_sid;
  const from = req.body.from || '';
  const callerName = req.body.caller_name || '';
  const leadId = callerName || from.replace('sip:', '').split('@')[0] || '';
  
  const session = new CallSession(callSid, leadId, from);
  sessions.set(callSid, session);

  const calledDid = extractDid(req.body);
  session.called_did = calledDid;
  console.log(`[${callSid}] Neuer Anruf von ${from} an ${calledDid} (Lead: ${leadId})`);

  const tenantConfig = await resolveTenantConfig(calledDid);
  session.tenant_config = tenantConfig;

  if (tenantConfig.LLM_API_KEY) session.llm_api_key = tenantConfig.LLM_API_KEY;
  if (tenantConfig.LLM_BASE_URL) session.llm_base_url = tenantConfig.LLM_BASE_URL;
  if (tenantConfig.LLM_MODEL) session.llm_model = tenantConfig.LLM_MODEL;
  if (tenantConfig.SMTP_HOST) session.smtp_host = tenantConfig.SMTP_HOST;
  if (tenantConfig.SMTP_PORT) session.smtp_port = parseInt(tenantConfig.SMTP_PORT) || 587;
  if (tenantConfig.SMTP_USER) session.smtp_user = tenantConfig.SMTP_USER;
  if (tenantConfig.SMTP_PASS) session.smtp_pass = tenantConfig.SMTP_PASS;
  if (tenantConfig.SMTP_FROM) session.smtp_from = tenantConfig.SMTP_FROM;
  if (tenantConfig.EMAIL_TO) session.email_to = tenantConfig.EMAIL_TO;
  if (tenantConfig.TTS_VENDOR) session.tts_vendor = tenantConfig.TTS_VENDOR;
  if (tenantConfig.TTS_VOICE_ID) session.tts_voice_id = tenantConfig.TTS_VOICE_ID;

  session.meetergo_config.enabled = tenantConfig.MEETERGO_ENABLED || (CONFIG.calendar_enabled ? 'true' : 'false');
  session.meetergo_config.user_id = tenantConfig.MEETERGO_USER_ID || CONFIG.meetergo_host_id;
  session.meetergo_config.api_key = tenantConfig.MEETERGO_API_KEY || CONFIG.meetergo_api_key;
  session.meetergo_config.meeting_type_id = tenantConfig.MEETERGO_MEETING_TYPE_ID || CONFIG.meetergo_meeting_type_id;
  session.meetergo_config.booking_api_key = tenantConfig.MEETERGO_BOOKING_API_KEY || tenantConfig.MEETERGO_API_KEY || CONFIG.meetergo_api_key;
  session.meetergo_config.booking_host_id = tenantConfig.MEETERGO_BOOKING_HOST_ID || tenantConfig.MEETERGO_USER_ID || CONFIG.meetergo_host_id;
  session.meetergo_config.booking_mtid = tenantConfig.MEETERGO_BOOKING_MTID || tenantConfig.MEETERGO_MEETING_TYPE_ID || CONFIG.meetergo_meeting_type_id;

  const { tools: dynamicTools, descriptions: toolDescriptions } = await resolveDynamicTools(calledDid);
  session.dynamic_tools = dynamicTools;

  const VERKAUF_PROMPT = loadPromptSync(CONFIG.verkauf_prompt_path, 'Du bist ein freundlicher Verkaufsassistent. Antworte immer auf Deutsch, kurz und praezise.');
  let systemPrompt = tenantConfig.prompt_system_prompt_txt || tenantConfig['prompt_system_prompt.txt'] || VERKAUF_PROMPT;
  const today = new Date().toISOString().split('T')[0];
  systemPrompt = `HEUTIGES DATUM: ${today}\nDie angerufene Nummer ist ${calledDid || 'unbekannt'}.\n\n${systemPrompt}`;
  if (toolDescriptions) systemPrompt += toolDescriptions;
  
  session.messages = [{ role: 'system', content: systemPrompt }];

  const activeLlmClient = (session.llm_api_key !== CONFIG.llm_api_key || session.llm_base_url !== CONFIG.llm_base_url)
    ? new OpenAI({ apiKey: session.llm_api_key, baseURL: session.llm_base_url })
    : llmClient;

  let greetingText = 'Hallo, wie kann ich Ihnen helfen?';
  try {
    const userPrompt = { role: 'user', content: 'Beginne jetzt das Gespraech. Begruessse den Anrufer.' };
    session.messages.push(userPrompt);
    
    const availableTools = getTools(session);
    const response = await activeLlmClient.chat.completions.create({
      model: session.llm_model,
      messages: session.messages,
      tools: availableTools.length > 0 ? availableTools : undefined,
      stream: false,
      ...buildExtraParams()
    });
    
    const msg = response.choices[0].message;
    
    const userPromptIndex = session.messages.findIndex(m => m === userPrompt);
    if (userPromptIndex !== -1) session.messages.splice(userPromptIndex, 1);
    
    if (msg.content) {
      greetingText = stripMarkup(msg.content);
      session.addMessage('assistant', greetingText);
    } else if (msg.tool_calls) {
      session.messages.push(msg);
      for (const toolCall of msg.tool_calls) {
        let toolArgs;
        try {
          toolArgs = JSON.parse(toolCall.function.arguments || '{}');
        } catch (e) {
          console.error(`[${callSid}] Invalid tool arguments JSON: ${e.message}`);
          toolArgs = {};
        }
        const toolResult = await executeTool(toolCall.function.name, toolArgs, session);
        session.messages.push({ 
          role: 'tool', 
          tool_call_id: toolCall.id,
          content: toolResult 
        });
      }
      
      const followUp = await activeLlmClient.chat.completions.create({
        model: session.llm_model,
        messages: session.messages,
        stream: false,
        ...buildExtraParams()
      });
      greetingText = stripMarkup(followUp.choices[0].message.content || 'Hallo, wie kann ich helfen?');
      session.addMessage('assistant', greetingText);
    }
  } catch (e) {
    console.error(`[${callSid}] LLM Fehler: ${e.message}`);
  }

  console.log(`[${callSid}] Bot: ${greetingText}`);
  res.json([{ 
    verb: 'gather', 
    input: ['speech'], 
    actionHook: '/actionHook', 
    timeout: 30, 
    say: sayTTS(greetingText, session), 
    listenDuringPrompt: true 
  }]);
});

app.post('/actionHook', requireWebhookAuth, async (req, res) => {
  const callSid = req.body.call_sid;
  const session = sessions.get(callSid);
  const reason = req.body.reason;

  if (!session) return res.json([{ verb: 'hangup' }]);

  if (session.duration > CONFIG.max_call_duration) {
    console.log(`[${callSid}] Max duration exceeded`);
    await session.finalize();
    return res.json([sayVerb('Das Gespräch wurde beendet.', session), { verb: 'hangup' }]);
  }

  if (session.transfer_state !== 'idle') {
    if (session.transfer_variant === 'cold' && session.transfer_target) {
      return res.json([{ verb: 'dial', target: [{ type: 'phone', number: session.transfer_target }] }]);
    }

    if (session.transfer_state === 'waiting_agent') {
      if (!CONFIG.hold_music_url) {
        return res.json([
          { verb: 'pause', length: 10 },
          { verb: 'redirect', actionHook: '/actionHook' }
        ]);
      }
      return res.json([
        { verb: 'play', url: CONFIG.hold_music_url },
        { verb: 'pause', length: 15 },
        { verb: 'redirect', actionHook: '/actionHook' }
      ]);
    }

    if (session.transfer_state === 'queueing') {
      if (!CONFIG.hold_music_url) {
        return res.json([
          { verb: 'pause', length: 10 },
          { verb: 'redirect', actionHook: '/actionHook' }
        ]);
      }
      return res.json([
        { verb: 'play', url: CONFIG.hold_music_url },
        { verb: 'pause', length: 20 },
        { verb: 'redirect', actionHook: '/actionHook' }
      ]);
    }

    if (session.transfer_state === 'agent_connected') {
      return res.json([sayVerb('Sie werden verbunden.', session)]);
    }
  }

  if (reason === 'timeout' || reason === 'no-input') {
    return res.json([{ 
      verb: 'gather', 
      input: ['speech'], 
      actionHook: '/actionHook', 
      timeout: 30, 
      say: sayTTS('Sind Sie noch da?', session), 
      listenDuringPrompt: true 
    }]);
  }

  const speechResult = req.body.speech?.alternatives?.[0]?.transcript;
  if (speechResult) {
    console.log(`[${callSid}] Kunde: ${speechResult}`);
    session.addMessage('user', speechResult);
  } else if (reason !== 'speechDetected') {
    return res.json([{ 
      verb: 'gather', 
      input: ['speech'], 
      actionHook: '/actionHook', 
      timeout: 30, 
      listenDuringPrompt: true 
    }]);
  }

  const activeLlmClient = (session.llm_api_key !== CONFIG.llm_api_key || session.llm_base_url !== CONFIG.llm_base_url)
    ? new OpenAI({ apiKey: session.llm_api_key, baseURL: session.llm_base_url })
    : llmClient;

  try {
    const availableTools = getTools(session);
    const response = await activeLlmClient.chat.completions.create({
      model: session.llm_model,
      messages: session.messages,
      tools: availableTools.length > 0 ? availableTools : undefined,
      stream: false,
      ...buildExtraParams()
    });
    
    const message = response.choices[0].message;

    if (message.tool_calls && message.tool_calls.length > 0) {
      session.messages.push(message);
      let transferQueued = false;

      for (const toolCall of message.tool_calls) {
        const toolName = toolCall.function.name;
        let toolArgs;
        try {
          toolArgs = JSON.parse(toolCall.function.arguments || '{}');
        } catch (e) {
          console.error(`[${callSid}] Invalid tool arguments JSON for ${toolName}: ${e.message}`);
          toolArgs = {};
        }
        console.log(`[${callSid}] Tool: ${toolName}`);

        if (toolName === 'end_call') {
          await session.finalize();
          return res.json([{ verb: 'hangup' }]);
        }

        const toolResult = await executeTool(toolName, toolArgs, session);
        session.messages.push({ role: 'tool', tool_call_id: toolCall.id, content: toolResult });

        if (toolName === 'transfer_call') {
          transferQueued = true;
        }
      }

      if (session.transfer_variant === 'cold' && session.transfer_target) {
        return res.json([{ verb: 'dial', target: [{ type: 'phone', number: session.transfer_target }] }]);
      }

      if (transferQueued && (session.transfer_variant === 'warm' || session.transfer_variant === 'consult')) {
        const introText = 'Einen Moment bitte, ich verbinde Sie mit einem Kollegen.';
        session.addMessage('assistant', introText);
        return res.json([
          sayVerb(introText, session),
          { verb: 'redirect', actionHook: '/actionHook' }
        ]);
      }

      if (transferQueued && session.transfer_variant === 'queue' && session.agent_call_sid) {
        const queueName = `support_${session.call_sid}`;
        await jambonzApi.createQueue(queueName);
        await session.enqueueCustomer(queueName);
        return res.sendStatus(200);
      }

      const followUp = await activeLlmClient.chat.completions.create({
        model: session.llm_model,
        messages: session.messages,
        stream: false,
        ...buildExtraParams()
      });
      const followUpText = stripMarkup(followUp.choices[0].message.content || '');
      if (followUpText) session.addMessage('assistant', followUpText);
      
      return res.json([{ 
        verb: 'gather', 
        input: ['speech'], 
        actionHook: '/actionHook', 
        timeout: 30, 
        say: sayTTS(followUpText || 'Kann ich sonst noch helfen?', session), 
        listenDuringPrompt: true 
      }]);
    }

    const text = stripMarkup(message.content || '');
    if (text) session.addMessage('assistant', text);
    console.log(`[${callSid}] Bot: ${text}`);
    
    res.json([{ 
      verb: 'gather', 
      input: ['speech'], 
      actionHook: '/actionHook', 
      timeout: 30, 
      say: sayTTS(text || 'Kann ich noch helfen?', session), 
      listenDuringPrompt: true 
    }]);
    
  } catch (e) {
    console.error(`[${callSid}] LLM Fehler: ${e.message}`);
    res.json([sayVerb('Entschuldigung, es gab ein technisches Problem.', session), { verb: 'hangup' }]);
  }
});

app.post('/agentHook', requireWebhookAuth, async (req, res) => {
  const agentCallSid = req.body.call_sid;
  const callStatus = req.body.call_status;

  let customerSession = null;
  for (const [sid, session] of sessions.entries()) {
    if (session.agent_call_sid === agentCallSid) {
      customerSession = session;
      break;
    }
  }
  
  if (!customerSession) {
    console.log(`[${agentCallSid}] No matching customer session found`);
    return res.sendStatus(404);
  }

  if (customerSession.duration > CONFIG.max_call_duration) {
    console.log(`[${customerSession.call_sid}] Max duration exceeded in agentHook`);
    await customerSession.fallbackToBot();
    return res.json([{ verb: 'hangup' }]);
  }

  console.log(`[${customerSession.call_sid}] Agent-Call ${agentCallSid} status: ${callStatus}`);

  if (callStatus === 'in-progress' || callStatus === 'answered') {
    if (customerSession.transfer_variant === 'consult') {
      const intro = `Anrufer ${customerSession.from}. ${customerSession.context_summary || 'Keine Zusammenfassung.'} Drücken Sie 1 zum Übernehmen.`;
      return res.json([
        sayVerb(intro, customerSession),
        { verb: 'gather', input: ['dtmf'], timeout: 15, say: sayTTS('Zum Übernehmen drücken Sie die 1.', customerSession), actionHook: '/agentDtmfHook', numDigits: 1 }
      ]);
    }

    if (customerSession.transfer_variant === 'queue') {
      if (customerSession.queue_name) {
        return res.json([{ verb: 'dequeue', queue: customerSession.queue_name }]);
      } else {
        await new Promise(r => setTimeout(r, 1000));
        if (customerSession.queue_name) {
          return res.json([{ verb: 'dequeue', queue: customerSession.queue_name }]);
        } else {
          await customerSession.fallbackToBot();
          return res.json([{ verb: 'hangup' }]);
        }
      }
    }

    await customerSession.connectCustomerToAgent();
    return res.json([sayVerb('Sie werden mit dem Anrufer verbunden.', customerSession)]);
  }

  if (callStatus === 'completed' || callStatus === 'failed' || callStatus === 'no-answer' || callStatus === 'busy') {
    console.log(`[${customerSession.call_sid}] Agent not available (${callStatus}), falling back to bot`);
    await customerSession.fallbackToBot();
    return res.sendStatus(200);
  }

  res.sendStatus(200);
});

app.post('/agentDtmfHook', requireWebhookAuth, async (req, res) => {
  const agentCallSid = req.body.call_sid;
  const dtmf = req.body.dtmf;
  
  let customerSession = null;
  for (const [sid, session] of sessions.entries()) {
    if (session.agent_call_sid === agentCallSid) {
      customerSession = session;
      break;
    }
  }
  
  if (!customerSession) return res.sendStatus(404);

  if (dtmf === '1') {
    await customerSession.connectCustomerToAgent();
    return res.json([sayVerb('Sie werden verbunden.', customerSession)]);
  } else {
    await customerSession.fallbackToBot();
    return res.json([{ verb: 'hangup' }]);
  }
});

app.post('/callStatus', requireWebhookAuth, async (req, res) => {
  const callSid = req.body.call_sid;
  const callStatus = req.body.call_status;
  
  console.log(`[${callSid}] Status: ${callStatus}`);
  
  if (['completed', 'failed', 'no-answer', 'busy'].includes(callStatus)) {
    const session = sessions.get(callSid);
    if (session && !session.finalizing) {
      setTimeout(() => session.finalize(), 3000);
    }
  }
  
  res.sendStatus(200);
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    calls: sessions.size,
    version: '4.1.0',
    uptime: process.uptime()
  });
});

// ══════════════════════════════════════════════════════════════════
//  START SERVER
// ══════════════════════════════════════════════════════════════════
const server = app.listen(CONFIG.port, () => {
  console.log(`\n╔════════════════════════════════════════════════════════════╗`);
  console.log(`║     Jambonz Voice AI Agent v4.1 - Production Ready      ║`);
  console.log(`╠════════════════════════════════════════════════════════════╣`);
  console.log(`║ Port:      ${CONFIG.port.toString().padEnd(44)}║`);
  console.log(`║ LLM:       ${CONFIG.llm_model.padEnd(44)}║`);
  console.log(`║ Backend:   ${CONFIG.backend_url.padEnd(44)}║`);
  console.log(`║ Jambonz:   ${CONFIG.jambonz_api_base_url.padEnd(44)}║`);
  console.log(`║ Redis:     ${CONFIG.redis_url.padEnd(44)}║`);
  console.log(`╚════════════════════════════════════════════════════════════╝\n`);
});

module.exports = { app, CONFIG, sessions, CallSession };