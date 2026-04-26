module.exports = {
  apps: [{
    name: "livekit-agent",
    script: "/root/livekit/agent/.venv/bin/python",
    args: "/root/livekit/agent/agent.py start",
    cwd: "/root/livekit/agent",
    watch: false,
    max_restarts: 10,
    restart_delay: 5000,
    max_memory_restart: "500M",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    error_file: "/root/livekit/agent/logs/error.log",
    out_file: "/root/livekit/agent/logs/output.log",
    merge_logs: true,
    env: {
      LIVEKIT_URL: "ws://127.0.0.1:7880",
      LIVEKIT_API_KEY: "API58c0ef038b1a0777ccd552ea4387c818",
      LIVEKIT_API_SECRET: "a67a654d881a61a3601ca053b52f641b0ce82bc023fd00e4e5e80b7293fb9370c5f535d57f861f6b50416adf8241428b9174254728ac34737c95bcfad10e9d0f",
      VIRTUAL_ENV: "/root/livekit/agent/.venv",
      PATH: "/root/livekit/agent/.venv/bin:/usr/local/bin:/usr/bin:/bin",
    }
  }]
};