# Livedial

VICIdial + LiveKit Installation for Debian 12

## Scripts

### `install.sh`
Full VICIdial installation for Debian 12. Includes Asterisk 18 (VICIdial fork), MariaDB, Apache, PHP 7.4, astguiclient, and all VICIdial components. Sets up crontab with all required maintenance jobs, Asterisk in Screen session for VICIdial compatibility, and logger configuration.

### `install-livekit.sh`
Installs LiveKit Server, LiveKit CLI, LiveKit SIP Bridge, Docker, and Redis. Configures Redis with safe defaults and systemd timeout. Sets up a SIP trunk between LiveKit and the local Asterisk instance.

### `install-agent.sh`
Sets up a Python voice agent with PM2 process manager. Installs required Python dependencies and configures the agent as a systemd service for automatic restart.

## Files

| File | Purpose |
|------|---------|
| `agent.py` | Python voice agent implementation |
| `ecosystem.config.js` | PM2 process configuration for the agent |
