#!/bin/bash
# install-livekit.sh - Automated LiveKit Installation (ohne Agent)
# Installs LiveKit + Redis + Docker + SIP Bridge + Dispatch Rules
# Agent-Setup separat via install-agent.sh
# Does NOT touch existing Vicidial installation.
set -euo pipefail

LIVEKIT_VERSION="${LIVEKIT_VERSION:-1.11.0}"
CLI_VERSION="${CLI_VERSION:-2.16.2}"
PROJECT_DIR="${PROJECT_DIR:-/root/livekit}"
REDIS_PASSWORD="${REDIS_PASSWORD:-}"
LK_API_KEY="${LK_API_KEY:-}"
LK_API_SECRET="${LK_API_SECRET:-}"
LIVEKIT_PORT="${LIVEKIT_PORT:-7880}"
SIP_PORT="${SIP_PORT:-5061}"

if [ -z "$REDIS_PASSWORD" ]; then
  REDIS_PASSWORD=$(openssl rand -hex 32)
fi
if [ -z "$LK_API_KEY" ]; then
  LK_API_KEY="API$(openssl rand -hex 16)"
fi
if [ -z "$LK_API_SECRET" ]; then
  LK_API_SECRET=$(openssl rand -hex 64)
fi

log() { echo "[$(date '+%H:%M:%S')] $*"; }
fatal() { log "FATAL: $*"; exit 1; }

mkdir -p "$PROJECT_DIR"/{bin,config,sip-bridge,agent}

# ------------------------------------------------------------------
log "Step 1/9: System packages"
apt-get update -qq
apt-get install -y -qq curl wget gnupg ca-certificates openssl tar gzip \
  redis-server python3 python3-pip python3-venv jq systemd >/dev/null 2>&1

# ------------------------------------------------------------------
log "Step 2/9: Redis installation + Autostart"
systemctl enable redis-server 2>/dev/null || true
cat > /etc/redis/redis.conf <<'REDISEOF'
bind 127.0.0.1 ::1
port 6379
daemonize no
supervised systemd
dir /var/lib/redis
stop-writes-on-bgsave-error no
requirepass __REDIS_PASSWORD__
rename-command FLUSHALL ""
rename-command FLUSHDB ""
REDISEOF
sed -i "s/__REDIS_PASSWORD__/$REDIS_PASSWORD/" /etc/redis/redis.conf
echo "vm.overcommit_memory = 1" >> /etc/sysctl.conf 2>/dev/null || true
sysctl -w vm.overcommit_memory=1 2>/dev/null || true
mkdir -p /etc/systemd/system/redis-server.service.d
cat > /etc/systemd/system/redis-server.service.d/timeout.conf <<'UNITEOF'
[Service]
TimeoutStopSec=30
UNITEOF
systemctl daemon-reload
systemctl restart redis-server 2>/dev/null || systemctl start redis-server
sleep 2
redis-cli -a "$REDIS_PASSWORD" CONFIG SET stop-writes-on-bgsave-error no 2>/dev/null || true
redis-cli -a "$REDIS_PASSWORD" ping >/dev/null 2>&1 || fatal "Redis not responding"
log "  Redis started + enabled"

# ------------------------------------------------------------------
log "Step 3/9: Docker installation"
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | bash >/dev/null 2>&1
  systemctl enable docker
  systemctl start docker
  sleep 2
fi
docker --version >/dev/null 2>&1 || fatal "Docker not available"
log "  Docker ready"

# ------------------------------------------------------------------
log "Step 4/9: LiveKit Server binary"
if [ ! -f "$PROJECT_DIR/bin/livekit-server" ]; then
  curl -fsSL "https://github.com/livekit/livekit/releases/download/v${LIVEKIT_VERSION}/livekit_${LIVEKIT_VERSION}_linux_amd64.tar.gz" -o /tmp/livekit.tar.gz
  tar -xzf /tmp/livekit.tar.gz -C /tmp/
  install -m 755 /tmp/livekit-server "$PROJECT_DIR/bin/livekit-server"
  rm -f /tmp/livekit.tar.gz /tmp/livekit-server /tmp/LICENSE 2>/dev/null || true
fi
log "  livekit-server v${LIVEKIT_VERSION}"

# ------------------------------------------------------------------
log "Step 5/9: livekit-cli"
if [ ! -f "$PROJECT_DIR/bin/lk" ]; then
  curl -fsSL "https://github.com/livekit/livekit-cli/releases/download/v${CLI_VERSION}/lk_${CLI_VERSION}_linux_amd64.tar.gz" -o /tmp/lk.tar.gz
  tar -xzf /tmp/lk.tar.gz -C /tmp/
  install -m 755 /tmp/lk "$PROJECT_DIR/bin/lk"
  rm -f /tmp/lk.tar.gz /tmp/lk 2>/dev/null || true
fi
export PATH="$PROJECT_DIR/bin:$PATH"
log "  livekit-cli v${CLI_VERSION}"

# ------------------------------------------------------------------
log "Step 6/9: LiveKit config + systemd service"
PUBLIC_IP=$(curl -4 -s https://ifconfig.me 2>/dev/null || echo "127.0.0.1")

cat > "$PROJECT_DIR/config/livekit.yaml" <<LKYAML
port: $LIVEKIT_PORT
rtc:
  port_range_start: 50000
  port_range_end: 60000
  tcp_port: 7881
  udp_port: 7881
  node_ip: $PUBLIC_IP
  use_external_ip: true
redis:
  address: localhost:6379
  password: "$REDIS_PASSWORD"
keys:
  "$LK_API_KEY": "$LK_API_SECRET"
logging:
  level: info
turn:
  enabled: false
bind_addresses:
  - "0.0.0.0"
LKYAML

cat > /etc/systemd/system/livekit.service <<'LKSVC'
[Unit]
Description=LiveKit Server
After=network.target redis-server.service
Requires=redis-server.service

[Service]
Type=simple
User=root
WorkingDirectory=__PROJECT_DIR__
ExecStart=__PROJECT_DIR__/bin/livekit-server --config __PROJECT_DIR__/config/livekit.yaml
Restart=on-failure
RestartSec=5
LimitNOFILE=1000000

[Install]
WantedBy=multi-user.target
LKSVC
sed -i "s|__PROJECT_DIR__|$PROJECT_DIR|g" /etc/systemd/system/livekit.service

systemctl daemon-reload
systemctl enable livekit
systemctl start livekit
sleep 3
curl -s http://127.0.0.1:$LIVEKIT_PORT/ >/dev/null 2>&1 || fatal "LiveKit server not responding"
log "  LiveKit Server running on port $LIVEKIT_PORT"

# ------------------------------------------------------------------
log "Step 7/9: SIP Bridge in Docker"
cat > "$PROJECT_DIR/sip-bridge/sip.yaml" <<SIPYAML
redis:
  address: "127.0.0.1:6379"
  password: "$REDIS_PASSWORD"
api_key: "$LK_API_KEY"
api_secret: "$LK_API_SECRET"
ws_url: "ws://127.0.0.1:$LIVEKIT_PORT"
sip_port: $SIP_PORT
sip_port_listen: $SIP_PORT
use_external_ip: true
logging:
  level: debug
SIPYAML

cat > "$PROJECT_DIR/sip-bridge/docker-compose.yml" <<SIPCOMP
services:
  sip:
    image: livekit/sip:latest
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./sip.yaml:/sip/config.yaml:ro
SIPCOMP

docker compose -f "$PROJECT_DIR/sip-bridge/docker-compose.yml" up -d 2>&1 || \
  docker run -d --name livekit-sip --restart unless-stopped --network host \
    -v "$PROJECT_DIR/sip-bridge/sip.yaml:/sip/config.yaml:ro" \
    livekit/sip:latest 2>&1
log "  SIP Bridge on port $SIP_PORT"

# ------------------------------------------------------------------
log "Step 8/9: Pull Egress + Ingress images"
docker pull livekit/egress:latest >/dev/null 2>&1 &
docker pull livekit/ingress:latest >/dev/null 2>&1 &
wait
log "  Egress + Ingress cached"

# ------------------------------------------------------------------
log "Step 9/9: Dispatch Rules + Credentials"

# Create SIP dispatch rule (routes SIP calls to rooms)
$PROJECT_DIR/bin/lk --url http://127.0.0.1:$LIVEKIT_PORT \
  --api-key "$LK_API_KEY" --api-secret "$LK_API_SECRET" \
  sip dispatch create \
  --name "inbound-call" \
  --individual "sip-" 2>&1 || log "  SIP dispatch rule: skipped"

# Create agent dispatch (dispatches agent to SIP rooms)
$PROJECT_DIR/bin/lk --url http://127.0.0.1:$LIVEKIT_PORT \
  --api-key "$LK_API_KEY" --api-secret "$LK_API_SECRET" \
  dispatch create \
  --agent-name "voice-agent" \
  --room "sip-" 2>&1 || log "  Agent dispatch: skipped"

# Save credentials
mkdir -p "$PROJECT_DIR/agent"
cat > "$PROJECT_DIR/config/credentials.txt" <<CRED
LIVEKIT_URL=http://$PUBLIC_IP:$LIVEKIT_PORT
LIVEKIT_API_KEY=$LK_API_KEY
LIVEKIT_API_SECRET=$LK_API_SECRET
REDIS_PASSWORD=$REDIS_PASSWORD
CRED

log ""
log "============================================"
log " LiveKit Installation complete!"
log "============================================"
log ""
log "  LiveKit Server:   http://$PUBLIC_IP:$LIVEKIT_PORT"
log "  API Key:          $LK_API_KEY"
log "  API Secret:       $LK_API_SECRET"
log "  Redis Password:   $REDIS_PASSWORD"
log ""
log "  SIP Bridge:       UDP/TCP port $SIP_PORT"
log ""
log "  NEXT STEPS:"
log "  Agent installieren:  ./install-agent.sh"
log "    (fragt LLM-, Deepgram- und Inworld-Keys interaktiv ab)"
log ""
log "  SIP in Vicidial/Asterisk auf Port $SIP_PORT weiterleiten"
log "============================================"