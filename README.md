# Livedial

VICIdial + LiveKit Installation for Debian 12

## Scripts

### `install.sh`
Full VICIdial installation for Debian 12. Includes Asterisk 18 (VICIdial fork), MariaDB, Apache, PHP 7.4, astguiclient, and all VICIdial components. Sets up crontab with all required maintenance jobs, Asterisk in Screen session for VICIdial compatibility, and logger configuration.

### `install-livekit.sh`
Installs LiveKit Server, LiveKit CLI, LiveKit SIP Bridge, Docker, and Redis. Configures Redis with safe defaults and systemd timeout. Sets up a SIP trunk between LiveKit and the local Asterisk instance.

### `install-agent.sh`
Sets up a Python voice agent with PM2 process manager. Installs required Python dependencies and configures the agent as a systemd service for automatic restart.

### `install-enhanced-agent.sh`
**Enhanced Agent + Dashboard** — upgrades the base agent with business logic ported from the Jambonz voice bot:
- **ViciDial API integration**: automatically updates lead status after each call
- **Decision LLM**: analyzes conversation outcome (POSITIV / NEGATIV / UNKLAR) and logs the result
- **Hangup tool**: the agent can end the call on request
- **Redis persistence**: call history and lead data stored for the dashboard
- **Express Dashboard (Node.js)**: real-time analytics, call list, search, timeline, and transcript viewer with login protection

## ⚠️ Important: API Keys are Placeholders!

The agent currently has placeholder keys configured after installation. You **must** edit the `.env` file and replace them with real API keys:

- `LLM_API_KEY=placeholder-llm-key`
- `DEEPGRAM_API_KEY=placeholder-deepgram-key`
- `INWORLD_API_KEY=placeholder-inworld-key`

After editing:

```bash
nano /root/livekit/agent/.env
pm2 restart livekit-agent
```

## Files

| File | Purpose |
|------|---------|
| `agent.py` | Python voice agent implementation (basic) |
| `enhanced_agent.py` | Enhanced Python agent with ViciDial API, decision LLM, hangup tool, Redis persistence |
| `dashboard/server.js` | Express dashboard server with auth, REST API, and analytics |
| `dashboard/public/dashboard.html` | Dashboard UI (call list, transcripts, stats) |
| `dashboard/public/login.html` | Login page for dashboard |
| `ecosystem.config.js` | PM2 process configuration for the agent |
| `install-enhanced-agent.sh` | Installer for the enhanced agent + dashboard |

## Jambonz Voice Bot (`jambonz-bot/`)

### PM2 Prozesse

| Name | Status | Beschreibung |
|------|--------|-------------|
| `jambonz-working` | gestoppt | Alte Version ohne TTS-Override |
| `jambonz-tts` | **aktiv** | Produktiv-Version mit TTS-Voice-Override |

### TTS Voice pro Tenant

Die App kann pro Tenant eine andere Inworld-TTS-Stimme setzen.  
Das Backend liefert `TTS_VOICE_ID` aus der Tenant-Config – der Code setzt dann einen separaten `say`-Verb mit `synthesizer` vor jedem `gather`.

**Format:**
```json
{
  "verb": "say",
  "text": "...",
  "synthesizer": {
    "vendor": "inworld",
    "label": "inworldgofonia",
    "voice": "Loretta"
  }
}
```

Wichtig: Der `synthesizer` muss in einem **separaten** `say`-Verb stehen (nicht im `say`-Objekt des `gather`).  
Das `gather` danach hat **kein** eigenes `say` mehr, sondern nur `listenDuringPrompt: true`.

**Backup der Produktiv-Datei:**
```
jambonz-bot/jambonz-app.js.PRODUKTIV-TTS-LORETTA_20260506_214336
```

**Fallback:** Alte Version starten mit `pm2 start jambonz-working`
