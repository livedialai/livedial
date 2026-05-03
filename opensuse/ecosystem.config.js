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
      VIRTUAL_ENV: "/root/livekit/agent/.venv",
      PATH: "/root/livekit/agent/.venv/bin:/usr/local/bin:/usr/bin:/bin",
    }
  }]
};
