#!/bin/bash
# install-enhanced-agent.sh — Enhanced LiveKit Agent + Dashboard (openSUSE)
# Single script: prompts once, installs everything automatically.
set -euo pipefail

LOGFILE="$(pwd)/install-enhanced-agent-$(date '+%Y%m%d-%H%M%S').log"
exec > >(tee "$LOGFILE") 2>&1

PROJECT_DIR="${PROJECT_DIR:-/root/livekit}"
AGENT_DIR="$PROJECT_DIR/enhanced"
DASHBOARD_DIR="$PROJECT_DIR/dashboard"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

log() { echo "[$(date '+%H:%M:%S')] $*"; }
fatal() { log "FATAL: $*"; exit 1; }

log "========================================"
log " Enhanced Agent + Dashboard Installation (openSUSE)"
log "========================================"

# ── Prerequisites: Python ──────────────────────────────────────────
PYTHON_BIN=""
for p in python3.11 python3; do
  if command -v "$p" &>/dev/null; then
    PYTHON_BIN="$p"
    break
  fi
done
if [ -z "$PYTHON_BIN" ]; then
  zypper --non-interactive install python311
  PYTHON_BIN="python3.11"
fi
log "Using Python: $PYTHON_BIN ($($PYTHON_BIN --version))"

# ── Prerequisites: Node.js ─────────────────────────────────────────
if ! command -v node &>/dev/null; then
  zypper --non-interactive install nodejs20
fi
if ! command -v npm &>/dev/null; then
  zypper --non-interactive install nodejs20
fi
if ! command -v pm2 &>/dev/null; then
  npm install -g pm2 >/dev/null 2>&1
fi
log "Node.js $(node -v) / PM2 $(pm2 -v 2>/dev/null || echo ok)"

# ── Read LiveKit credentials ───────────────────────────────────────
if [ ! -f "$PROJECT_DIR/config/credentials.txt" ]; then
  fatal "No LiveKit credentials found. Run install-livekit.sh first."
fi

LK_KEY=$(grep LIVEKIT_API_KEY "$PROJECT_DIR/config/credentials.txt" | cut -d= -f2)
LK_SECRET=$(grep LIVEKIT_API_SECRET "$PROJECT_DIR/config/credentials.txt" | cut -d= -f2)
LK_URL=$(grep LIVEKIT_URL "$PROJECT_DIR/config/credentials.txt" | cut -d= -f2)
REDIS_PASS=$(grep REDIS_PASSWORD "$PROJECT_DIR/config/credentials.txt" | cut -d= -f2)

if [ -z "$LK_KEY" ] || [ -z "$LK_SECRET" ]; then
  fatal "Incomplete LiveKit credentials"
fi
log "LiveKit credentials loaded"

# ── Read existing .env defaults ────────────────────────────────────
ENV_FILE="$PROJECT_DIR/agent/.env"
_LLM_BASE_URL=$(grep '^LLM_BASE_URL=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)
_LLM_API_KEY=$(grep '^LLM_API_KEY=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)
_LLM_MODEL=$(grep '^LLM_MODEL=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)
_DEEPGRAM_API_KEY=$(grep '^DEEPGRAM_API_KEY=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)
_DEEPGRAM_MODEL=$(grep '^DEEPGRAM_MODEL=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)
_DEEPGRAM_LANGUAGE=$(grep '^DEEPGRAM_LANGUAGE=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)
_INWORLD_API_KEY=$(grep '^INWORLD_API_KEY=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)
_INWORLD_BASE_URL=$(grep '^INWORLD_BASE_URL=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)
_INWORLD_VOICE_ID=$(grep '^INWORLD_VOICE_ID=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)

# ── Prompt for all credentials ─────────────────────────────────────
echo ""
echo "--- ViciDial API Credentials ---"
read -r -p "ViciDial URL [${_VICIDIAL_URL:-http://localhost/agc}]: " VICIDIAL_URL
VICIDIAL_URL="${VICIDIAL_URL:-${_VICIDIAL_URL:-http://localhost/agc}}"
read -r -p "ViciDial User [${_VICIDIAL_USER:-6666}]: " VICIDIAL_USER
VICIDIAL_USER="${VICIDIAL_USER:-${_VICIDIAL_USER:-6666}}"
read -r -p "ViciDial Pass [${_VICIDIAL_PASS:+***}]: " VICIDIAL_PASS
VICIDIAL_PASS="${VICIDIAL_PASS:-${_VICIDIAL_PASS:-}}"
read -r -p "POSITIV status [${_VICIDIAL_POSITIV_STATUS:-SALE}]: " VICIDIAL_POSITIV_STATUS
VICIDIAL_POSITIV_STATUS="${VICIDIAL_POSITIV_STATUS:-${_VICIDIAL_POSITIV_STATUS:-SALE}}"
read -r -p "NEGATIV status [${_VICIDIAL_NEGATIV_STATUS:-XFER}]: " VICIDIAL_NEGATIV_STATUS
VICIDIAL_NEGATIV_STATUS="${VICIDIAL_NEGATIV_STATUS:-${_VICIDIAL_NEGATIV_STATUS:-XFER}}"

echo ""
echo "--- LLM (Deepseek/OpenAI-compatible) ---"
read -r -p "Base URL [${_LLM_BASE_URL:-https://api.infomaniak.com/2/ai/107009/openai/v1}]: " LLM_BASE_URL
LLM_BASE_URL="${LLM_BASE_URL:-${_LLM_BASE_URL:-https://api.infomaniak.com/2/ai/107009/openai/v1}}"
read -r -p "API Key [${_LLM_API_KEY:+***}]: " LLM_API_KEY
LLM_API_KEY="${LLM_API_KEY:-${_LLM_API_KEY:-}}"
read -r -p "Model [${_LLM_MODEL:-qwen3}]: " LLM_MODEL
LLM_MODEL="${LLM_MODEL:-${_LLM_MODEL:-qwen3}}"

echo ""
echo "--- Deepgram STT ---"
read -r -p "API Key [${_DEEPGRAM_API_KEY:+***}]: " DEEPGRAM_API_KEY
DEEPGRAM_API_KEY="${DEEPGRAM_API_KEY:-${_DEEPGRAM_API_KEY:-}}"
read -r -p "Model [${_DEEPGRAM_MODEL:-nova-3}]: " DEEPGRAM_MODEL
DEEPGRAM_MODEL="${DEEPGRAM_MODEL:-${_DEEPGRAM_MODEL:-nova-3}}"
read -r -p "Language [${_DEEPGRAM_LANGUAGE:-de}]: " DEEPGRAM_LANGUAGE
DEEPGRAM_LANGUAGE="${DEEPGRAM_LANGUAGE:-${_DEEPGRAM_LANGUAGE:-de}}"

echo ""
echo "--- Inworld TTS ---"
read -r -p "API Key [${_INWORLD_API_KEY:+***}]: " INWORLD_API_KEY
INWORLD_API_KEY="${INWORLD_API_KEY:-${_INWORLD_API_KEY:-}}"
read -r -p "Voice ID [${_INWORLD_VOICE_ID:-default-gir-n2kfw-hbdko0a0q9lw__multi-de}]: " INWORLD_VOICE_ID
INWORLD_VOICE_ID="${INWORLD_VOICE_ID:-${_INWORLD_VOICE_ID:-default-gir-n2kfw-hbdko0a0q9lw__multi-de}}"
read -r -p "Base URL [${_INWORLD_BASE_URL:-https://api.inworld.ai/v1}]: " INWORLD_BASE_URL
INWORLD_BASE_URL="${INWORLD_BASE_URL:-${_INWORLD_BASE_URL:-https://api.inworld.ai/v1}}"

echo ""
echo "--- Dashboard Login ---"
read -r -p "User [${_DASHBOARD_USER:-admin}]: " DASHBOARD_USER
DASHBOARD_USER="${DASHBOARD_USER:-${_DASHBOARD_USER:-admin}}"
read -r -p "Pass [${_DASHBOARD_PASS:+***}]: " DASHBOARD_PASS
DASHBOARD_PASS="${DASHBOARD_PASS:-${_DASHBOARD_PASS:-changeme123}}"
read -r -p "Port [${_DASHBOARD_PORT:-3456}]: " DASHBOARD_PORT
DASHBOARD_PORT="${DASHBOARD_PORT:-${_DASHBOARD_PORT:-3456}}"

# ── Firewall ───────────────────────────────────────────────────────
echo ""
read -r -p "Automatisch Firewall-Regeln setzen? (y/n) [y]: " OPEN_FW
OPEN_FW="${OPEN_FW:-y}"
if [ "$OPEN_FW" = "y" ]; then
  FW_CMD=""
  if command -v firewall-cmd &>/dev/null; then
    FW_CMD="firewall-cmd --permanent"
  elif command -v /sbin/SuSEfirewall2 &>/dev/null; then
    FW_CMD="/sbin/SuSEfirewall2"
  fi
  if [ -n "$FW_CMD" ]; then
    for port in "$DASHBOARD_PORT" 7880 5070; do
      $FW_CMD --add-port="${port}/tcp" 2>/dev/null || true
    done
    $FW_CMD --add-port=5070/udp 2>/dev/null || true
    if echo "$FW_CMD" | grep -q firewall-cmd; then
      firewall-cmd --reload >/dev/null 2>&1 || true
    fi
    log "Firewall-Regeln gesetzt"
  else
    log "Kein Firewall-Tool gefunden (überspringe)"
  fi
fi

# ── Enhanced agent .env ────────────────────────────────────────────
mkdir -p "$AGENT_DIR"
cat > "$AGENT_DIR/.env" <<ENVEOF
LIVEKIT_URL=${LK_URL}
LIVEKIT_API_KEY=${LK_KEY}
LIVEKIT_API_SECRET=${LK_SECRET}

LLM_API_KEY=${LLM_API_KEY}
LLM_BASE_URL=${LLM_BASE_URL}
LLM_MODEL=${LLM_MODEL}

DEEPGRAM_API_KEY=${DEEPGRAM_API_KEY}
DEEPGRAM_MODEL=${DEEPGRAM_MODEL}
DEEPGRAM_LANGUAGE=${DEEPGRAM_LANGUAGE}

INWORLD_API_KEY=${INWORLD_API_KEY}
INWORLD_BASE_URL=${INWORLD_BASE_URL}
INWORLD_VOICE_ID=${INWORLD_VOICE_ID}

AGENT_INSTRUCTIONS=Du bist ein hilfreicher KI-Sprachassistent im Telefonat. Sei höflich, professionell, antworte auf Deutsch, kurz und natürlich.

VICIDIAL_URL=${VICIDIAL_URL}
VICIDIAL_USER=${VICIDIAL_USER}
VICIDIAL_PASS=${VICIDIAL_PASS}
VICIDIAL_POSITIV_STATUS=${VICIDIAL_POSITIV_STATUS}
VICIDIAL_NEGATIV_STATUS=${VICIDIAL_NEGATIV_STATUS}

REDIS_PASSWORD=${REDIS_PASS}
DASHBOARD_PORT=${DASHBOARD_PORT}
MAX_CALL_DURATION_SECONDS=600
ENVEOF
log "Enhanced agent .env written"

# ── Dashboard .env ─────────────────────────────────────────────────
mkdir -p "$DASHBOARD_DIR"
cat > "$SCRIPT_DIR/dashboard/.env" <<DASHENV
REDIS_PASSWORD=${REDIS_PASS}
DASHBOARD_PORT=${DASHBOARD_PORT}
DASHBOARD_USER=${DASHBOARD_USER}
DASHBOARD_PASS=${DASHBOARD_PASS}
VICIDIAL_URL=${VICIDIAL_URL}
DASHENV
log "Dashboard .env written"

# ── Python venv ────────────────────────────────────────────────────
mkdir -p "$AGENT_DIR/logs"
if [ ! -d "$AGENT_DIR/.venv" ] || [ ! -x "$AGENT_DIR/.venv/bin/$PYTHON_BIN" ]; then
  log "Creating Python venv..."
  rm -rf "$AGENT_DIR/.venv"
  $PYTHON_BIN -m venv "$AGENT_DIR/.venv"
fi

log "Installing Python dependencies..."
"$AGENT_DIR/.venv/bin/$PYTHON_BIN" -m pip install -q -U pip setuptools wheel
"$AGENT_DIR/.venv/bin/$PYTHON_BIN" -m pip install -q \
  "livekit-agents~=1.5" \
  "livekit-plugins-deepgram~=1.5" \
  "livekit-plugins-openai~=1.5" \
  "livekit-plugins-inworld~=1.5" \
  "livekit-plugins-silero~=1.5" \
  "python-dotenv~=1.0" \
  "livekit-api" \
  httpx "redis>=5" 2>&1 | tail -3
log "Python deps installed"

# ── enhanced_agent.py from livedial ────────────────────────────────
if [ -f "$SCRIPT_DIR/enhanced_agent.py" ]; then
  cp "$SCRIPT_DIR/enhanced_agent.py" "$AGENT_DIR/enhanced_agent.py"
  log "enhanced_agent.py copied"
elif [ -f "$PROJECT_DIR/livedial/enhanced_agent.py" ]; then
  cp "$PROJECT_DIR/livedial/enhanced_agent.py" "$AGENT_DIR/enhanced_agent.py"
  log "enhanced_agent.py copied from livedial/"
elif [ ! -f "$AGENT_DIR/enhanced_agent.py" ]; then
  fatal "enhanced_agent.py not found"
fi

# ── Dashboard npm deps ─────────────────────────────────────────────
if [ ! -d "$DASHBOARD_DIR/node_modules" ]; then
  log "Installing dashboard npm dependencies..."
  cd "$SCRIPT_DIR"
  npm install --silent 2>&1 | tail -3
fi
log "Dashboard npm deps ready"

# ── PM2 ecosystem ──────────────────────────────────────────────────
cat > "$AGENT_DIR/ecosystem.config.js" <<ECO
module.exports = {
  apps: [
    {
      name: "enhanced-agent",
      script: "$AGENT_DIR/.venv/bin/$PYTHON_BIN",
      args: "$AGENT_DIR/enhanced_agent.py start",
      cwd: "$AGENT_DIR",
      watch: false,
      max_restarts: 10,
      restart_delay: 5000,
      max_memory_restart: "500M",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "$AGENT_DIR/logs/error.log",
      out_file: "$AGENT_DIR/logs/output.log",
      merge_logs: true,
    },
    {
      name: "dashboard-server",
      script: "node",
      args: "$SCRIPT_DIR/server.js",
      cwd: "$SCRIPT_DIR",
      watch: false,
      max_restarts: 5,
      restart_delay: 3000,
      max_memory_restart: "200M",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "$DASHBOARD_DIR/logs/error.log",
      out_file: "$DASHBOARD_DIR/logs/output.log",
      merge_logs: true,
    }
  ]
};
ECO
mkdir -p "$DASHBOARD_DIR/logs"
log "PM2 ecosystem written"

# ── Stop old, start new ────────────────────────────────────────────
pm2 delete enhanced-agent 2>/dev/null || true
pm2 delete dashboard-server 2>/dev/null || true

log "Starting Enhanced Agent + Dashboard..."
pm2 start "$AGENT_DIR/ecosystem.config.js" 2>&1 | tail -5
pm2 save --force 2>&1 | tail -1
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

# ── SIP Dispatch Rule ──────────────────────────────────────────────
log "Creating SIP dispatch rule..."
"$AGENT_DIR/.venv/bin/$PYTHON_BIN" - <<PYEOF
import asyncio
from livekit.api import (
    LiveKitAPI, SIPDispatchRule, SIPDispatchRuleIndividual,
    RoomConfiguration, RoomAgentDispatch, CreateSIPDispatchRuleRequest
)
async def main():
    api = LiveKitAPI(url="http://127.0.0.1:7880", api_key="${LK_KEY}", api_secret="${LK_SECRET}")
    existing = await api.sip.list_sip_dispatch_rule()
    for r in existing:
        await api.sip.delete_sip_dispatch_rule(r.sip_dispatch_rule_id)
    req = CreateSIPDispatchRuleRequest(
        name="inbound-call",
        rule=SIPDispatchRule(dispatch_rule_individual=SIPDispatchRuleIndividual(room_prefix="sip-_")),
        room_config=RoomConfiguration(agents=[RoomAgentDispatch(agent_name="voice-agent")])
    )
    result = await api.sip.create_sip_dispatch_rule(req)
    print(f"  Dispatch Rule: {result.sip_dispatch_rule_id}")
    await api.aclose()
asyncio.run(main())
PYEOF

# ── Status ─────────────────────────────────────────────────────────
sleep 3
echo ""
log "========================================"
log " Enhanced Agent Installation Complete!"
log "========================================"
echo ""
pm2 status 2>&1 | grep -E "enhanced-agent|dashboard|name" || true
echo ""
log "  Dashboard:   http://$(hostname -I | awk '{print $1}'):${DASHBOARD_PORT}"
log "  Agent logs:  pm2 logs enhanced-agent"
log "  Dashboard:   pm2 logs dashboard-server"
log "  Login:       ${DASHBOARD_USER} / ${DASHBOARD_PASS}"
log "========================================"
