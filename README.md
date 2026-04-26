# Livedial

VICIdial + LiveKit Setup Scripts for Debian 12

## Scripts

| Script | Description |
|--------|-------------|
| `install.sh` | Full VICIdial installation: Asterisk 18, MariaDB, Apache, PHP 7.4, astguiclient, crontab, Screen-Session-Management |
| `install-livekit.sh` | LiveKit Server + SIP Bridge + Docker + Redis |
| `install-agent.sh` | Voice Agent Setup with PM2 |
| `agent.py` | Python Voice Agent |
| `ecosystem.config.js` | PM2 process configuration |

## Key Features

- Asterisk runs in a Screen session (`screen -dmS asterisk`) for VICIdial compatibility
- Redis configured with safe defaults (`dir /var/lib/redis`, `TimeoutStopSec=30`)
- Comprehensive crontab with all VICIdial maintenance jobs
- Auto-cleanup for stale screen sessions
- All dependencies included (`libnet-telnet-perl` etc.)
