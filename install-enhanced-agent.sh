#!/bin/bash
# install-enhanced-agent.sh — Enhanced LiveKit Agent + Dashboard
# Console logging to timestamped logfile in current directory
set -euo pipefail

LOGFILE="$(pwd)/install-enhanced-agent-$(date '+%Y%m%d-%H%M%S').log"
exec > >(tee "$LOGFILE") 2>&1

PROJECT_DIR="${PROJECT_DIR:-/root/livekit}"
AGENT_DIR="$PROJECT_DIR/enhanced"
DASHBOARD_DIR="$PROJECT_DIR/dashboard"

log() { echo "[$(date '+%H:%M:%S')] $*"; }
fatal() { log "FATAL: $*"; exit 1; }

# ── Verify existing LiveKit install ───────────────────────────────────
log "========================================"
log " Enhanced Agent + Dashboard Installation"
log "========================================"

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
log "✅ LiveKit credentials found"

# ── Read current agent .env ───────────────────────────────────────────
if [ -f "$PROJECT_DIR/agent/.env" ]; then
  _LLM_BASE_URL=$(grep '^LLM_BASE_URL=' "$PROJECT_DIR/agent/.env" 2>/dev/null | cut -d= -f2- || true)
  _LLM_API_KEY=$(grep '^LLM_API_KEY=' "$PROJECT_DIR/agent/.env" 2>/dev/null | cut -d= -f2- || true)
  _LLM_MODEL=$(grep '^LLM_MODEL=' "$PROJECT_DIR/agent/.env" 2>/dev/null | cut -d= -f2- || true)
  _DEEPGRAM_API_KEY=$(grep '^DEEPGRAM_API_KEY=' "$PROJECT_DIR/agent/.env" 2>/dev/null | cut -d= -f2- || true)
  _DEEPGRAM_MODEL=$(grep '^DEEPGRAM_MODEL=' "$PROJECT_DIR/agent/.env" 2>/dev/null | cut -d= -f2- || true)
  _DEEPGRAM_LANGUAGE=$(grep '^DEEPGRAM_LANGUAGE=' "$PROJECT_DIR/agent/.env" 2>/dev/null | cut -d= -f2- || true)
  _INWORLD_API_KEY=$(grep '^INWORLD_API_KEY=' "$PROJECT_DIR/agent/.env" 2>/dev/null | cut -d= -f2- || true)
  _INWORLD_BASE_URL=$(grep '^INWORLD_BASE_URL=' "$PROJECT_DIR/agent/.env" 2>/dev/null | cut -d= -f2- || true)
  _INWORLD_VOICE_ID=$(grep '^INWORLD_VOICE_ID=' "$PROJECT_DIR/agent/.env" 2>/dev/null | cut -d= -f2- || true)
fi

# ── Prompt for credentials ────────────────────────────────────────────
log ""
log "--- ViciDial API Credentials ---"
read -r -p "ViciDial URL [${_VICIDIAL_URL:-http://localhost/agc}]: " VICIDIAL_URL
VICIDIAL_URL="${VICIDIAL_URL:-${_VICIDIAL_URL:-http://localhost/agc}}"
read -r -p "ViciDial User [${_VICIDIAL_USER:-6666}]: " VICIDIAL_USER
VICIDIAL_USER="${VICIDIAL_USER:-${_VICIDIAL_USER:-6666}}"
read -r -p "ViciDial Pass [${_VICIDIAL_PASS:+***}]: " VICIDIAL_PASS
VICIDIAL_PASS="${VICIDIAL_PASS:-${_VICIDIAL_PASS:-}}"

read -r -p "ViciDial POSITIV status [${_VICIDIAL_POSITIV_STATUS:-SALE}]: " VICIDIAL_POSITIV_STATUS
VICIDIAL_POSITIV_STATUS="${VICIDIAL_POSITIV_STATUS:-${_VICIDIAL_POSITIV_STATUS:-SALE}}"
read -r -p "ViciDial NEGATIV status [${_VICIDIAL_NEGATIV_STATUS:-XFER}]: " VICIDIAL_NEGATIV_STATUS
VICIDIAL_NEGATIV_STATUS="${VICIDIAL_NEGATIV_STATUS:-${_VICIDIAL_NEGATIV_STATUS:-XFER}}"

log ""
log "--- Dashboard Credentials ---"
read -r -p "Dashboard user [${_DASHBOARD_USER:-admin}]: " DASHBOARD_USER
DASHBOARD_USER="${DASHBOARD_USER:-${_DASHBOARD_USER:-admin}}"
read -r -p "Dashboard pass [${_DASHBOARD_PASS:+***}]: " DASHBOARD_PASS
DASHBOARD_PASS="${DASHBOARD_PASS:-${_DASHBOARD_PASS:-changeme123}}"
read -r -p "Dashboard port [${_DASHBOARD_PORT:-3456}]: " DASHBOARD_PORT
DASHBOARD_PORT="${DASHBOARD_PORT:-${_DASHBOARD_PORT:-3456}}"

# ── Agent .env ────────────────────────────────────────────────────────
mkdir -p "$AGENT_DIR"
cat > "$AGENT_DIR/.env" <<ENVEOF
LIVEKIT_URL=${LK_URL}
LIVEKIT_API_KEY=${LK_KEY}
LIVEKIT_API_SECRET=${LK_SECRET}

LLM_API_KEY=${_LLM_API_KEY:-}
LLM_BASE_URL=${_LLM_BASE_URL:-https://api.infomaniak.com/2/ai/107009/openai/v1}
LLM_MODEL=${_LLM_MODEL:-qwen3}

DEEPGRAM_API_KEY=${_DEEPGRAM_API_KEY:-}
DEEPGRAM_MODEL=${_DEEPGRAM_MODEL:-nova-3}
DEEPGRAM_LANGUAGE=${_DEEPGRAM_LANGUAGE:-de}

INWORLD_API_KEY=${_INWORLD_API_KEY:-}
INWORLD_BASE_URL=${_INWORLD_BASE_URL:-https://api.inworld.ai/v1}
INWORLD_VOICE_ID=${_INWORLD_VOICE_ID:-default-gir-n2kfw-hbdko0a0q9lw__multi-de}

AGENT_INSTRUCTIONS=Du bist ein hilfreicher KI-Sprachassistent im Telefonat. Sei höflich, professionell, antworte auf Deutsch, kurz und natürlich.

# ── ViciDial ─────────────────────────────────────────────────────────
VICIDIAL_URL=${VICIDIAL_URL}
VICIDIAL_USER=${VICIDIAL_USER}
VICIDIAL_PASS=${VICIDIAL_PASS}
VICIDIAL_POSITIV_STATUS=${VICIDIAL_POSITIV_STATUS}
VICIDIAL_NEGATIV_STATUS=${VICIDIAL_NEGATIV_STATUS}

# ── Dashboard / Redis ─────────────────────────────────────────────────
REDIS_PASSWORD=${REDIS_PASS}
DASHBOARD_PORT=${DASHBOARD_PORT}
MAX_CALL_DURATION_SECONDS=600
ENVEOF
log "✅ Enhanced agent .env written"

# ── Install Python deps in existing venv ──────────────────────────────
VENVP="$PROJECT_DIR/agent/.venv"
if [ ! -x "$VENVP/bin/pip" ]; then
  fatal "Agent venv not found. Run install-agent.sh first."
fi

log "Installing Python dependencies..."
"$VENVP/bin/pip" install -q httpx "redis>=5" 2>&1 | tail -3
log "✅ Python deps installed"

# ── Install Node.js if needed ────────────────────────────────────────
if ! command -v node &>/dev/null; then
  log "Installing Node.js..."
  apt-get update -qq && apt-get install -y -qq nodejs npm 2>&1 | tail -3
fi
node -v >/dev/null 2>&1 || fatal "Node.js not available"
log "✅ Node.js $(node -v)"

# ── Install dashboard npm deps ────────────────────────────────────────
log "Installing dashboard Node dependencies..."
cd "$DASHBOARD_DIR"
npm install --silent 2>&1 | tail -3
log "✅ Dashboard npm deps installed"

# ── PM2 ecosystem ─────────────────────────────────────────────────────
cat > "$AGENT_DIR/ecosystem.config.js" <<ECO
module.exports = {
  apps: [
    {
      name: "enhanced-agent",
      script: "$VENVP/bin/python",
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
      args: "$DASHBOARD_DIR/server.js",
      cwd: "$DASHBOARD_DIR",
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
log "✅ PM2 ecosystem written"

# ── Stop old agent, start new ───────────────────────────────────────────
pm2 delete livekit-agent 2>/dev/null || true
pm2 delete enhanced-agent 2>/dev/null || true
pm2 delete dashboard-server 2>/dev/null || true

log "Starting Enhanced Agent + Dashboard..."
cd "$AGENT_DIR"
pm2 start ecosystem.config.js 2>&1 | tail -5
pm2 save --force 2>&1 | tail -1

# ── Status ────────────────────────────────────────────────────────────
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
