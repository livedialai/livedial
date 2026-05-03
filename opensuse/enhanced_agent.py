import os
import json
import asyncio
import time
import logging
from datetime import datetime
from typing import Optional
from dotenv import load_dotenv

import httpx
import redis.asyncio as redis

from livekit.agents import (
    Agent,
    AgentSession,
    AutoSubscribe,
    JobContext,
    WorkerOptions,
    cli,
    RunContext,
    function_tool,
)
from livekit.plugins import deepgram, openai, inworld, silero

# ── Load env ──────────────────────────────────────────────────────────
ENV_PATH = os.path.join(os.path.dirname(__file__), ".env")
load_dotenv(ENV_PATH)

LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "")
LLM_MODEL = os.getenv("LLM_MODEL", "qwen3")

DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY", "")
DEEPGRAM_MODEL = os.getenv("DEEPGRAM_MODEL", "nova-3")
DEEPGRAM_LANGUAGE = os.getenv("DEEPGRAM_LANGUAGE", "de")

INWORLD_API_KEY = os.getenv("INWORLD_API_KEY", "")
INWORLD_BASE_URL = os.getenv("INWORLD_BASE_URL", "https://api.inworld.ai/v1")
INWORLD_VOICE_ID = os.getenv("INWORLD_VOICE_ID", "default-gir-n2kfw-hbdko0a0q9lw__multi-de")

# ── Load prompts from files ───────────────────────────────────────────
AGENT_DIR = os.path.dirname(__file__)

def load_prompt_file(filename: str, fallback: str) -> str:
    filepath = os.path.join(AGENT_DIR, filename)
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            content = f.read().strip()
        if content:
            logging.getLogger("livekit-enhanced-agent").info(f"✅ Loaded prompt from {filename}")
            return content
    except Exception as exc:
        logging.getLogger("livekit-enhanced-agent").warning(f"Could not load {filename}: {exc}, using fallback")
    return fallback

VERKAUF_PROMPT = load_prompt_file(
    "verkaufsprompt.txt",
    os.getenv(
        "AGENT_INSTRUCTIONS",
        "Du bist ein hilfreicher KI-Sprachassistent in einem Telefonat. "
        "Sei höflich, professionell und antworte präzise auf Deutsch. "
        "Halte deine Antworten kurz und natürlich.",
    )
)

AGENT_INSTRUCTIONS = VERKAUF_PROMPT  # Use sales prompt as main instructions

VICIDIAL_URL = os.getenv("VICIDIAL_URL", "")
VICIDIAL_USER = os.getenv("VICIDIAL_USER", "")
VICIDIAL_PASS = os.getenv("VICIDIAL_PASS", "")
VICIDIAL_POSITIV_STATUS = os.getenv("VICIDIAL_POSITIV_STATUS", "SALE")
VICIDIAL_NEGATIV_STATUS = os.getenv("VICIDIAL_NEGATIV_STATUS", "XFER")

REDIS_PASSWORD = os.getenv("REDIS_PASSWORD", "")
MAX_CALL_DURATION = int(os.getenv("MAX_CALL_DURATION_SECONDS", "600"))

ENTSCHEIDER_PROMPT = load_prompt_file(
    "entscheiderprompt.txt",
    os.getenv(
        "ENTSCHEIDER_PROMPT",
        """Analysieren Sie das Gespräch und bestimmen Sie das Ergebnis.
Antworten Sie NUR mit einem JSON-Objekt in exakt diesem Format:

{
  "outcome": "POSITIV|NEGATIV|UNKLAR",
  "confidence": 0.0-1.0,
  "reason": "Kurze Begründung"
}

KATEGORIEN:
- POSITIV: Kunde hat Interesse gezeigt, zugestimmt, E-Mail Opt-in gegeben, Informationen angefordert, Beispiele gewünscht, Rückruf vereinbart oder positiv reagiert.
- NEGATIV: Kunde hat KLAR abgelehnt ("Nein danke", "Kein Interesse", "Nicht interessiert", explizite Absage)
- UNKLAR: Gespräch wurde abgebrochen, Kunde antwortet nicht mehr, technische Probleme, oder völlig unklar

Antworten Sie NUR mit dem JSON-Objekt, nichts anderes.""",
    )
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler()],
)
logger = logging.getLogger("livekit-enhanced-agent")


# ════════════════════════════════════════════════════════════════════════
#  REDIS
# ════════════════════════════════════════════════════════════════════════
_redis_pool: Optional[redis.Redis] = None


async def get_redis() -> redis.Redis:
    global _redis_pool
    if _redis_pool is None:
        _redis_pool = redis.Redis(
            host="localhost",
            port=6379,
            password=REDIS_PASSWORD or None,
            decode_responses=True,
        )
    return _redis_pool


# ════════════════════════════════════════════════════════════════════════
#  CALL SESSION
# ════════════════════════════════════════════════════════════════════════
class CallSession:
    def __init__(self, call_sid: str, caller: str, lead_id: Optional[str] = None):
        self.call_sid = call_sid
        self.caller = caller
        self.lead_id = lead_id
        self.start_time = time.time()
        self.messages = [{"role": "system", "content": AGENT_INSTRUCTIONS}]
        self.conversation = []
        self.lead_status: Optional[str] = None
        self.lead_analyse: Optional[str] = None
        self.vicidial_updated = False
        self.outcome = None
        self.interaction_count = 0

    def duration(self) -> int:
        return int(time.time() - self.start_time)

    def add_conversation(self, speaker: str, text: str):
        self.conversation.append(
            {"role": speaker, "content": text, "timestamp": datetime.utcnow().isoformat()}
        )

    def add_user_message(self, text: str):
        self.messages.append({"role": "user", "content": text})
        self.add_conversation("KUNDE", text)
        self.interaction_count += 1

    def add_assistant_message(self, text: str):
        cleaned = text.replace("*", "").strip()
        if cleaned:
            self.messages.append({"role": "assistant", "content": cleaned})
            self.add_conversation("NADINE", cleaned)

    def get_conversation_text(self) -> str:
        return "\n".join(
            f"{'Kunde' if m['role'] == 'user' else 'Bot'}: {m['content']}"
            for m in self.messages
            if m["role"] in ("user", "assistant")
        )


# ════════════════════════════════════════════════════════════════════════
#  VICIDIAL API
# ════════════════════════════════════════════════════════════════════════
async def update_vicidial_lead(lead_id: str, status: str) -> dict:
    if not VICIDIAL_URL or not VICIDIAL_USER or not VICIDIAL_PASS:
        logger.warning("VICIDIAL credentials missing, skipping")
        return {"success": False}
    cleaned = str(lead_id).strip().replace('"', "")
    if not cleaned.isdigit():
        logger.error(f"Invalid lead_id: {lead_id}")
        return {"success": False}
    url = (
        f"{VICIDIAL_URL}/agc/api.php"
        f"?source=livekit_agent&user={VICIDIAL_USER}&pass={VICIDIAL_PASS}"
        f"&function=update_lead&lead_id={cleaned}&status={status}"
    )
    for attempt in range(1, 4):
        try:
            async with httpx.AsyncClient(verify=False, timeout=5.0) as client:
                resp = await client.get(url)
            body = resp.text
            if "SUCCESS" in body:
                logger.info(f"[VICIDIAL] lead {cleaned} -> {status}")
                return {"success": True, "leadId": cleaned, "status": status}
        except Exception as exc:
            logger.error(f"[VICIDIAL] attempt {attempt} failed: {exc}")
            await asyncio.sleep(1)
    logger.error(f"[VICIDIAL] Permanent failure for lead {cleaned}")
    return {"success": False}


# ════════════════════════════════════════════════════════════════════════
#  DECISION ANALYSIS
# ════════════════════════════════════════════════════════════════════════
async def analyze_outcome(call_session: CallSession) -> str:
    logger.info(f"[{call_session.call_sid}] Analyzing outcome ...")
    prompt = f"""{ENTSCHEIDER_PROMPT}

GESPRÄCHSVERLAUF:
{call_session.get_conversation_text()}
"""
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{LLM_BASE_URL.rstrip('/')}/chat/completions",
                headers={
                    "Authorization": f"Bearer {LLM_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": LLM_MODEL,
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": 200,
                    "temperature": 0.3,
                },
            )
        data = resp.json()
        text = data["choices"][0]["message"]["content"]
        match = text[text.find("{"): text.rfind("}") + 1]
        if not match:
            raise ValueError("No JSON block")
        analysis = json.loads(match)
        outcome = analysis.get("outcome", "UNKLAR").upper()
        confidence = analysis.get("confidence", 0.0)
        reason = analysis.get("reason", "")
        logger.info(f"[{call_session.call_sid}] Outcome={outcome} confidence={confidence} reason={reason}")
        call_session.lead_analyse = reason
        return outcome
    except Exception as exc:
        logger.error(f"[{call_session.call_sid}] Analysis failed: {exc}")
        return "UNKLAR"


# ════════════════════════════════════════════════════════════════════════
#  REDIS PERSISTENCE
# ════════════════════════════════════════════════════════════════════════
async def save_call_to_redis(call_session: CallSession):
    r = await get_redis()
    payload = {
        "callSid": call_session.call_sid,
        "from": call_session.caller,
        "leadId": call_session.lead_id,
        "leadStatus": call_session.lead_status or "UNKLAR",
        "leadAnalyse": call_session.lead_analyse,
        "vicidialUpdated": call_session.vicidial_updated,
        "duration": call_session.duration(),
        "messageCount": call_session.interaction_count,
        "conversation": call_session.conversation,
        "timestamp": datetime.utcnow().isoformat(),
        "models": {"llm": LLM_MODEL, "llmProvider": LLM_BASE_URL},
        "streaming": True,
    }
    await r.setex(f"call:{call_session.call_sid}", 30 * 86400, json.dumps(payload))
    logger.info(f"[{call_session.call_sid}] Call saved to Redis")


async def save_lead_to_redis(call_session: CallSession):
    if not call_session.lead_id:
        return
    r = await get_redis()
    key = f"lead:{call_session.lead_id}"
    raw = await r.get(key)
    now = datetime.utcnow().isoformat()
    if raw:
        lead_data = json.loads(raw)
        lead_data["calls"].append(
            {"callSid": call_session.call_sid, "timestamp": now, "duration": call_session.duration(), "status": call_session.lead_status}
        )
        lead_data["callCount"] = len(lead_data["calls"])
        lead_data["lastCall"] = now
        if call_session.lead_status:
            lead_data["status"] = call_session.lead_status
            lead_data["lastAnalyse"] = call_session.lead_analyse
        if call_session.vicidial_updated:
            lead_data["vicidialUpdated"] = True
            lead_data["lastVicidialUpdate"] = now
    else:
        lead_data = {
            "leadId": call_session.lead_id,
            "status": call_session.lead_status or "UNKLAR",
            "analyse": call_session.lead_analyse,
            "firstCall": now,
            "lastCall": now,
            "callCount": 1,
            "calls": [{"callSid": call_session.call_sid, "timestamp": now, "duration": call_session.duration(), "status": call_session.lead_status}],
        }
    await r.setex(key, 30 * 86400, json.dumps(lead_data))
    logger.info(f"[{call_session.call_sid}] Lead {call_session.lead_id} saved to Redis")


# ════════════════════════════════════════════════════════════════════════
#  HANGUP TOOL
# ════════════════════════════════════════════════════════════════════════
_sessions: dict[str, CallSession] = {}


@function_tool()
async def hangup(run_ctx: RunContext) -> str:
    """Beende das Telefonat auf Wunsch des Kunden."""
    room_name = run_ctx.room.name
    logger.info(f"[{room_name}] hangup tool invoked")
    asyncio.create_task(_finalize_call(room_name))
    return "Das Gespräch wird jetzt beendet. Auf Wiederhören!"


async def _finalize_call(room_name: str):
    call_session = _sessions.pop(room_name, None)
    if not call_session:
        return
    outcome = await analyze_outcome(call_session)
    call_session.lead_status = outcome
    if outcome != "UNKLAR" and call_session.lead_id:
        status = VICIDIAL_POSITIV_STATUS if outcome == "POSITIV" else VICIDIAL_NEGATIV_STATUS
        result = await update_vicidial_lead(call_session.lead_id, status)
        call_session.vicidial_updated = result.get("success", False)
    await save_call_to_redis(call_session)
    await save_lead_to_redis(call_session)
    try:
        await call_session._room.disconnect()
    except Exception:
        pass


# ════════════════════════════════════════════════════════════════════════
#  VOICE AGENT (subclass)
# ════════════════════════════════════════════════════════════════════════
class VoiceAgent(Agent):
    def __init__(self, call_session: CallSession, **kwargs):
        super().__init__(**kwargs)
        self.call_session = call_session
        self._room = None

    def on_enter(self):
        logger.info(f"[{self.call_session.call_sid}] Agent entered room")
        self._room = self.session.room if hasattr(self, "session") else None
        if self._room:
            self.call_session._room = self._room

    def on_user_turn_completed(self, message):
        text = str(message).strip()
        if text:
            logger.info(f"[{self.call_session.call_sid}] User: {text[:80]}")
            self.call_session.add_user_message(text)

    def on_exit(self):
        logger.info(f"[{self.call_session.call_sid}] Agent exiting, finalizing")
        asyncio.create_task(_finalize_call(self.call_session.call_sid))


# ════════════════════════════════════════════════════════════════════════
#  ENTRYPOINT
# ════════════════════════════════════════════════════════════════════════
async def entrypoint(ctx: JobContext):
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)
    room_name = ctx.room.name
    caller = "unknown"
    lead_id: Optional[str] = None

    # Extract metadata
    for p in ctx.room.remote_participants.values():
        meta = p.metadata or "{}"
        try:
            md = json.loads(meta)
            caller = md.get("phoneNumber", p.identity)
            lead_id = md.get("leadId") or md.get("lead_id")
        except Exception:
            caller = p.identity
    logger.info(f"[{room_name}] New call from {caller} | lead_id={lead_id}")

    call_session = CallSession(room_name, caller, lead_id)
    _sessions[room_name] = call_session

    # Max-duration watchdog
    async def watchdog():
        while room_name in _sessions:
            await asyncio.sleep(5)
            s = _sessions.get(room_name)
            if s and s.duration() > MAX_CALL_DURATION:
                logger.info(f"[{room_name}] Max duration reached")
                await _finalize_call(room_name)
                return
    asyncio.create_task(watchdog())

    # Room disconnect handler
    @ctx.room.on("disconnected")
    def _on_disconnect():
        logger.info(f"[{room_name}] Room disconnected")
        asyncio.create_task(_finalize_call(room_name))

    # Configure pipeline plugins
    stt = deepgram.STT(
        model=DEEPGRAM_MODEL,
        language=DEEPGRAM_LANGUAGE,
        api_key=DEEPGRAM_API_KEY,
    )
    llm = openai.LLM(
        model=LLM_MODEL,
        base_url=LLM_BASE_URL,
        api_key=LLM_API_KEY,
    )
    tts = inworld.TTS(
        base_url=INWORLD_BASE_URL,
        api_key=INWORLD_API_KEY,
        voice=INWORLD_VOICE_ID,
    )
    vad = silero.VAD.load()
    agent = VoiceAgent(
        call_session=call_session,
        instructions=AGENT_INSTRUCTIONS,
        stt=stt,
        llm=llm,
        tts=tts,
        vad=vad,
        tools=[hangup],
    )

    agent_session = AgentSession()
    await agent_session.start(agent=agent, room=ctx.room)

    # Greet
    await agent_session.generate_reply(
        instructions="Greet the caller warmly in German and ask how you can help."
    )


if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, agent_name="voice-agent"))
