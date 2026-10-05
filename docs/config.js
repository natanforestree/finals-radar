/* Lobby log API base URL (the Cloudflare Worker), e.g. "https://ruby-radar.example.workers.dev".
   Empty = not connected yet: the lobby buttons show disabled. See dev/DATA-CONTRACT.md, "Lobby log API".
   For local testing, ?api=http://localhost:8787 overrides this (localhost / 127.0.0.1 only). */
window.RUBY_RADAR_API = "https://ruby-radar.nathanforestlee.workers.dev";
