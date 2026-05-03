module.exports = {
  apps: [{
    name: "pipecat-bot",
    script: "/root/livekit/livedial/pipecat-bot/.venv/bin/python",
    args: "/root/livekit/livedial/pipecat-bot/bot.py --host 0.0.0.0 --port 3004 --transport daily --dialin",
    cwd: "/root/livekit/livedial/pipecat-bot",
    watch: false,
    max_restarts: 10,
    restart_delay: 5000,
    max_memory_restart: "500M",
    log_date_format: "YYYY-MM-DD HH:mm:ss",
    error_file: "/root/livekit/livedial/pipecat-bot/error.log",
    out_file: "/root/livekit/livedial/pipecat-bot/output.log",
    merge_logs: true,
  }]
};