#!/bin/bash
# install-agent.sh - Automated LiveKit Voice Agent Setup
# Idempotent: can be run multiple times safely.
# Prompts for API keys and installs the agent with PM2.
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/root/livekit}"
AGENT_DIR="$PROJECT_DIR/agent"
LIVEKIT_URL="${LIVEKIT_URL:-ws://127.0.0.1:7880}"

log() { echo "[$(date '+%H:%M:%S')] $*"; }
fatal() { log "FATAL: $*"; exit 1; }

# ------------------------------------------------------------------
# Gather API keys interactively (with defaults from existing .env)
# ------------------------------------------------------------------
if [ -f "$AGENT_DIR/.env" ]; then
  # Read existing values as defaults
  _DEEPGRAM_API_KEY=$(grep '^DEEPGRAM_API_KEY=' "$AGENT_DIR/.env" 2>/dev/null | cut -d= -f2- || true)
  _DEEPGRAM_MODEL=$(grep '^DEEPGRAM_MODEL=' "$AGENT_DIR/.env" 2>/dev/null | cut -d= -f2- || true)
  _DEEPGRAM_LANGUAGE=$(grep '^DEEPGRAM_LANGUAGE=' "$AGENT_DIR/.env" 2>/dev/null | cut -d= -f2- || true)
  _LLM_BASE_URL=$(grep '^LLM_BASE_URL=' "$AGENT_DIR/.env" 2>/dev/null | cut -d= -f2- || true)
  _LLM_API_KEY=$(grep '^LLM_API_KEY=' "$AGENT_DIR/.env" 2>/dev/null | cut -d= -f2- || true)
  _LLM_MODEL=$(grep '^LLM_MODEL=' "$AGENT_DIR/.env" 2>/dev/null | cut -d= -f2- || true)
  _INWORLD_API_KEY=$(grep '^INWORLD_API_KEY=' "$AGENT_DIR/.env" 2>/dev/null | cut -d= -f2- || true)
  _INWORLD_VOICE_ID=$(grep '^INWORLD_VOICE_ID=' "$AGENT_DIR/.env" 2>/dev/null | cut -d= -f2- || true)
  _INWORLD_BASE_URL=$(grep '^INWORLD_BASE_URL=' "$AGENT_DIR/.env" 2>/dev/null | cut -d= -f2- || true)
fi

read -r -p "LLM Base URL [${_LLM_BASE_URL:-https://api.infomaniak.com/2/ai/107009/openai/v1}]: " LLM_BASE_URL
LLM_BASE_URL="${LLM_BASE_URL:-${_LLM_BASE_URL:-https://api.infomaniak.com/2/ai/107009/openai/v1}}"
read -r -p "LLM API Key [${_LLM_API_KEY:+***}]: " LLM_API_KEY
LLM_API_KEY="${LLM_API_KEY:-${_LLM_API_KEY:-}}"
read -r -p "LLM Model [${_LLM_MODEL:-qwen3}]: " LLM_MODEL
LLM_MODEL="${LLM_MODEL:-${_LLM_MODEL:-qwen3}}"
read -r -p "Deepgram API Key [${_DEEPGRAM_API_KEY:+***}]: " DEEPGRAM_API_KEY
DEEPGRAM_API_KEY="${DEEPGRAM_API_KEY:-${_DEEPGRAM_API_KEY:-}}"
read -r -p "Deepgram Model [${_DEEPGRAM_MODEL:-nova-3}]: " DEEPGRAM_MODEL
DEEPGRAM_MODEL="${DEEPGRAM_MODEL:-${_DEEPGRAM_MODEL:-nova-3}}"
read -r -p "Deepgram Language [${_DEEPGRAM_LANGUAGE:-de}]: " DEEPGRAM_LANGUAGE
DEEPGRAM_LANGUAGE="${DEEPGRAM_LANGUAGE:-${_DEEPGRAM_LANGUAGE:-de}}"
read -r -p "Inworld API Key [${_INWORLD_API_KEY:+***}]: " INWORLD_API_KEY
INWORLD_API_KEY="${INWORLD_API_KEY:-${_INWORLD_API_KEY:-}}"
read -r -p "Inworld Voice ID [${_INWORLD_VOICE_ID:-default-gir-n2kfw-hbdko0a0q9lw__multi-de}]: " INWORLD_VOICE_ID
INWORLD_VOICE_ID="${INWORLD_VOICE_ID:-${_INWORLD_VOICE_ID:-default-gir-n2kfw-hbdko0a0q9lw__multi-de}}"
read -r -p "Inworld Base URL [${_INWORLD_BASE_URL:-https://api.inworld.ai/v1}]: " INWORLD_BASE_URL
INWORLD_BASE_URL="${INWORLD_BASE_URL:-${_INWORLD_BASE_URL:-https://api.inworld.ai/v1}}"

# ------------------------------------------------------------------
# Check prerequisites
# ------------------------------------------------------------------
if ! command -v python3 &>/dev/null; then
  apt-get update -qq && apt-get install -y -qq python3 python3-pip python3-venv >/dev/null 2>&1
fi
if ! command -v pm2 &>/dev/null; then
  if command -v npm &>/dev/null; then
    npm install -g pm2 >/dev/null 2>&1
  else
    apt-get install -y -qq npm >/dev/null 2>&1 && npm install -g pm2 >/dev/null 2>&1
  fi
fi

# ------------------------------------------------------------------
# Read LiveKit API credentials from existing config
# ------------------------------------------------------------------
LK_API_KEY=""
LK_API_SECRET=""
if [ -f "$PROJECT_DIR/config/livekit.yaml" ]; then
  LK_API_KEY=$(grep -A1 'keys:' "$PROJECT_DIR/config/livekit.yaml" | tail -1 | awk -F'"' '{print $2}')
  LK_API_SECRET=$(grep -A1 'keys:' "$PROJECT_DIR/config/livekit.yaml" | tail -1 | awk -F'"' '{print $4}')
fi

log "LiveKit API Key: ${LK_API_KEY:-<nicht gefunden>}"
log "LiveKit API Secret: ${LK_API_SECRET:+***}"

# ------------------------------------------------------------------
# Create agent directory and Python venv
# ------------------------------------------------------------------
mkdir -p "$AGENT_DIR/logs"

if [ ! -d "$AGENT_DIR/.venv" ] || [ ! -x "$AGENT_DIR/.venv/bin/python3" ]; then
  log "Erstelle Python venv..."
  rm -rf "$AGENT_DIR/.venv"
  python3 -m venv "$AGENT_DIR/.venv"
fi

log "Installiere Agent-Abhängigkeiten..."
"$AGENT_DIR/.venv/bin/pip" install -q -U pip setuptools wheel
"$AGENT_DIR/.venv/bin/pip" install -q \
  "livekit-agents~=1.5" \
  "livekit-plugins-deepgram~=1.5" \
  "livekit-plugins-openai~=1.5" \
  "livekit-plugins-inworld~=1.5" \
  "livekit-plugins-silero~=1.5" \
  "python-dotenv~=1.0" \
  "livekit-api" \
  2>&1 | tail -3
log "Agent-Abhängigkeiten installiert"

# ------------------------------------------------------------------
# Write .env
# ------------------------------------------------------------------
cat > "$AGENT_DIR/.env" <<ENVEOF
LIVEKIT_URL=$LIVEKIT_URL
LIVEKIT_API_KEY=${LK_API_KEY:-}
LIVEKIT_API_SECRET=${LK_API_SECRET:-}

LLM_API_KEY=$LLM_API_KEY
LLM_BASE_URL=$LLM_BASE_URL
LLM_MODEL=$LLM_MODEL

DEEPGRAM_API_KEY=$DEEPGRAM_API_KEY
DEEPGRAM_MODEL=$DEEPGRAM_MODEL
DEEPGRAM_LANGUAGE=$DEEPGRAM_LANGUAGE

INWORLD_API_KEY=$INWORLD_API_KEY
INWORLD_BASE_URL=$INWORLD_BASE_URL
INWORLD_VOICE_ID=$INWORLD_VOICE_ID

AGENT_INSTRUCTIONS=Du bist ein hilfreicher KI-Sprachassistent in einem Telefonat. Sei höflich, professionell und antworte präzise auf Deutsch. Halte deine Antworten kurz und natürlich.
ENVEOF
log ".env geschrieben"

# ------------------------------------------------------------------
# Write agent.py (always overwrite to keep in sync)
# ------------------------------------------------------------------
cat > "$AGENT_DIR/agent.py" <<'AGENTPY'
import os
from dotenv import load_dotenv
from livekit.agents import (
    Agent,
    AgentSession,
    AutoSubscribe,
    JobContext,
    WorkerOptions,
    cli,
)
from livekit.plugins import deepgram, openai, inworld, silero

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

SYSTEM_INSTRUCTIONS = os.getenv(
    "AGENT_INSTRUCTIONS",
    "Du bist ein hilfreicher KI-Sprachassistent in einem Telefonat. "
    "Sei höflich, professionell und antworte präzise auf Deutsch. "
    "Halte deine Antworten kurz und natürlich.",
)


async def entrypoint(ctx: JobContext):
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    stt = deepgram.STT(
        model=os.getenv("DEEPGRAM_MODEL", "nova-3"),
        language=os.getenv("DEEPGRAM_LANGUAGE", "de"),
        api_key=os.getenv("DEEPGRAM_API_KEY"),
    )
    llm = openai.LLM(
        model=os.getenv("LLM_MODEL", "gpt-4o-mini"),
        base_url=os.getenv("LLM_BASE_URL"),
        api_key=os.getenv("LLM_API_KEY"),
    )
    tts = inworld.TTS(
        base_url=os.getenv("INWORLD_BASE_URL", "https://api.inworld.ai/v1"),
        api_key=os.getenv("INWORLD_API_KEY"),
        voice=os.getenv("INWORLD_VOICE_ID", ""),
    )
    vad = silero.VAD.load()

    session = AgentSession(vad=vad, stt=stt, llm=llm, tts=tts)
    agent = Agent(instructions=SYSTEM_INSTRUCTIONS)

    await session.start(agent=agent, room=ctx.room)
    await session.generate_reply(
        instructions="Greet the caller in German and ask how you can help."
    )


if __name__ == "__main__":
    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            agent_name="voice-agent",
        )
    )
AGENTPY
log "agent.py erstellt"

# ------------------------------------------------------------------
# Write PM2 ecosystem file
# ------------------------------------------------------------------
cat > "$AGENT_DIR/ecosystem.config.js" <<ECO
module.exports = {
  apps: [{
    name: "livekit-agent",
    script: "$AGENT_DIR/.venv/bin/python",
    args: "$AGENT_DIR/agent.py start",
    cwd: "$AGENT_DIR",
    watch: false,
    max_restarts: 10,
    restart_delay: 5000,
    max_memory_restart: "500M",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    error_file: "$AGENT_DIR/logs/error.log",
    out_file: "$AGENT_DIR/logs/output.log",
    merge_logs: true,
  }]
};
ECO
log "ecosystem.config.js erstellt"

# ------------------------------------------------------------------
# Write systemd service (fallback / alternative to PM2)
# ------------------------------------------------------------------
cat > /etc/systemd/system/livekit-agent.service <<AGENTSVC
[Unit]
Description=LiveKit Voice Agent
After=network.target livekit.service

[Service]
Type=simple
User=root
WorkingDirectory=$AGENT_DIR
ExecStart=$AGENT_DIR/.venv/bin/python agent.py start
Restart=on-failure
RestartSec=10
Environment=LIVEKIT_URL=$LIVEKIT_URL
Environment=LIVEKIT_API_KEY=${LK_API_KEY:-}
Environment=LIVEKIT_API_SECRET=${LK_API_SECRET:-}

[Install]
WantedBy=multi-user.target
AGENTSVC
systemctl daemon-reload

# ------------------------------------------------------------------
# Stop existing PM2 process if running
# ------------------------------------------------------------------
pm2 delete livekit-agent 2>/dev/null || true

# ------------------------------------------------------------------
# Start agent via PM2
# ------------------------------------------------------------------
cd "$AGENT_DIR"
pm2 start ecosystem.config.js 2>&1 | tail -3
pm2 save --force 2>&1 | tail -1

# Enable PM2 startup if not done already
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

# ------------------------------------------------------------------
# Create SIP dispatch rule with agent_name via Python API
# ------------------------------------------------------------------
LK_CLI="$PROJECT_DIR/bin/lk"
if [ -x "$LK_CLI" ] && [ -n "${LK_API_KEY:-}" ] && [ -n "${LK_API_SECRET:-}" ]; then
  log "Erstelle SIP Dispatch Rule mit agent_name=voice-agent..."

  # Delete existing rules first
  for rule_id in $($LK_CLI --url "http://127.0.0.1:7880" \
    --api-key "$LK_API_KEY" --api-secret "$LK_API_SECRET" \
    sip dispatch list 2>/dev/null | grep -oP 'SDR_\w+' || true); do
    log "  Loesche alte Regel: $rule_id"
    $LK_CLI --url "http://127.0.0.1:7880" \
      --api-key "$LK_API_KEY" --api-secret "$LK_API_SECRET" \
      sip dispatch delete "$rule_id" -y 2>/dev/null || true
  done

  # Create new rule with agent_name using Python API
  "$AGENT_DIR/.venv/bin/python3" - <<PYEOF
import asyncio, sys
try:
    from livekit.api import (
        LiveKitAPI, SIPDispatchRule, SIPDispatchRuleIndividual,
        RoomConfiguration, RoomAgentDispatch, CreateSIPDispatchRuleRequest
    )

    async def main():
        api = LiveKitAPI(
            url="http://127.0.0.1:7880",
            api_key="${LK_API_KEY}",
            api_secret="${LK_API_SECRET}"
        )
        req = CreateSIPDispatchRuleRequest(
            name="inbound-call",
            rule=SIPDispatchRule(
                dispatch_rule_individual=SIPDispatchRuleIndividual(room_prefix="sip-_")
            ),
            room_config=RoomConfiguration(
                agents=[RoomAgentDispatch(agent_name="voice-agent")]
            )
        )
        result = await api.sip.create_sip_dispatch_rule(req)
        print(f"  Dispatch Rule erstellt: {result.sip_dispatch_rule_id}")
        await api.aclose()

    asyncio.run(main())
except Exception as e:
    print(f"  WARN: Konnte Dispatch Rule nicht erstellen: {e}", file=sys.stderr)
    print("  Erstelle Fallback-Regel ohne agent_name...")
    import subprocess
    subprocess.run([
        "$LK_CLI", "--url", "http://127.0.0.1:7880",
        "--api-key", "${LK_API_KEY}", "--api-secret", "${LK_API_SECRET}",
        "sip", "dispatch", "create",
        "--caller", "sip-_", "--name", "inbound-call", "-y"
    ], capture_output=True)
PYEOF

fi

# ------------------------------------------------------------------
# Status
# ------------------------------------------------------------------
sleep 5
echo ""
log "============================================"
log " Agent Installation abgeschlossen!"
log "============================================"
echo ""
pm2 status 2>&1 | grep -E "livekit-agent|id.*name" || true
echo ""
log "  Wichtige Befehle:"
log "    pm2 status                    # Status anzeigen"
log "    pm2 logs livekit-agent        # Logs anzeigen"
log "    pm2 restart livekit-agent     # Neustarten"
log "    pm2 stop livekit-agent        # Stoppen"
echo ""
log "  .env Datei: $AGENT_DIR/.env"
log "  agent.py:    $AGENT_DIR/agent.py"
log "  Agent-Name:  voice-agent"
log "============================================"