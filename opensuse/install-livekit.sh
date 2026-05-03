#!/bin/bash
# install-livekit.sh - openSUSE-Adapted Automated LiveKit Installation
# Installs LiveKit + Redis + Docker + SIP Bridge + Dispatch Rules
# Agent-Setup separat via install-agent.sh
set -euo pipefail

LOGFILE="$(pwd)/install-livekit-$(date '+%Y%m%d-%H%M%S').log"
exec > >(tee "$LOGFILE") 2>&1

LIVEKIT_VERSION="${LIVEKIT_VERSION:-1.11.0}"
CLI_VERSION="${CLI_VERSION:-2.16.2}"
PROJECT_DIR="${PROJECT_DIR:-/root/livekit}"
REDIS_PASSWORD="${REDIS_PASSWORD:-}"
LK_API_KEY="${LK_API_KEY:-}"
LK_API_SECRET="${LK_API_SECRET:-}"
LIVEKIT_PORT="${LIVEKIT_PORT:-7880}"
SIP_PORT="${SIP_PORT:-5070}"

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
log "Step 1/9: System packages (openSUSE)"
zypper --non-interactive refresh
zypper --non-interactive install curl wget gpg2 ca-certificates openssl tar gzip \
  redis python311 python311-pip jq

# ------------------------------------------------------------------
log "Step 2/9: Redis installation + Autostart (openSUSE instance-based)"
systemctl stop redis@livekit 2>/dev/null || true
mkdir -p /var/lib/redis/livekit
chown redis:redis /var/lib/redis/livekit

# Create Redis instance config
cp -a /etc/redis/default.conf.example /etc/redis/livekit.conf
chown root:redis /etc/redis/livekit.conf
chmod u=rw,g=r,o= /etc/redis/livekit.conf

cat >> /etc/redis/livekit.conf <<REDISEOF

# ---- LiveKit custom settings ----
bind 127.0.0.1 ::1
port 6379
dir /var/lib/redis/livekit
pidfile /run/redis/livekit.pid
stop-writes-on-bgsave-error no
requirepass __REDIS_PASSWORD__
rename-command FLUSHALL ""
rename-command FLUSHDB ""
REDISEOF
sed -i "s/__REDIS_PASSWORD__/$REDIS_PASSWORD/" /etc/redis/livekit.conf

echo "vm.overcommit_memory = 1" >> /etc/sysctl.conf 2>/dev/null || true
sysctl -w vm.overcommit_memory=1 2>/dev/null || true

mkdir -p /etc/systemd/system/redis@livekit.service.d
cat > /etc/systemd/system/redis@livekit.service.d/timeout.conf <<UNITEOF
[Service]
TimeoutStopSec=30
UNITEOF

systemctl daemon-reload
systemctl enable redis@livekit
systemctl restart redis@livekit || systemctl start redis@livekit
sleep 2
redis-cli -a "$REDIS_PASSWORD" CONFIG SET stop-writes-on-bgsave-error no 2>/dev/null || true
redis-cli -a "$REDIS_PASSWORD" ping >/dev/null 2>&1 || fatal "Redis not responding"
log "  Redis (livekit instance) started + enabled"

# ------------------------------------------------------------------
log "Step 3/9: Docker installation"
if ! command -v docker &>/dev/null; then
  zypper --non-interactive install docker docker-compose
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
After=network.target redis@livekit.service
Requires=redis@livekit.service

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
for img in livekit/egress:latest livekit/ingress:latest; do
  if ! docker image inspect "$img" >/dev/null 2>&1; then
    timeout 300 docker pull "$img" >/dev/null 2>&1 || log "  WARN: could not pull $img"
  fi
done
log "  Egress + Ingress cached"

# ------------------------------------------------------------------
log "Step 9/9: Dispatch Rule (SIP + Agent)"

python3.11 - <<PYEOF
import asyncio
from livekit.api import (
    LiveKitAPI, SIPDispatchRule, SIPDispatchRuleIndividual,
    RoomConfiguration, RoomAgentDispatch, CreateSIPDispatchRuleRequest
)
async def main():
    api = LiveKitAPI(url="http://127.0.0.1:$LIVEKIT_PORT", api_key="$LK_API_KEY", api_secret="$LK_API_SECRET")
    existing = await api.sip.list_sip_dispatch_rule()
    for r in existing:
        await api.sip.delete_sip_dispatch_rule(r.sip_dispatch_rule_id)
    req = CreateSIPDispatchRuleRequest(
        name="inbound-call",
        rule=SIPDispatchRule(dispatch_rule_individual=SIPDispatchRuleIndividual(room_prefix="sip-_")),
        room_config=RoomConfiguration(agents=[RoomAgentDispatch(agent_name="voice-agent")])
    )
    result = await api.sip.create_sip_dispatch_rule(req)
    print(f"  Dispatch Rule: {result.sip_dispatch_rule_id} (SIP + Agent)")
    await api.aclose()
asyncio.run(main())
PYEOF

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
