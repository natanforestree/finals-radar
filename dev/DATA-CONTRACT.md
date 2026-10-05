# Data contract: collector → page

The collector (`collector/collect.py`, run by GitHub Actions every ~10 min) writes
two files into `docs/data/`. The page (`docs/index.html`) only reads these two.

All times are UTC. ISO strings look like `2026-10-05T15:56:02Z`.

## How "active" is measured

Embark's ranked leaderboard (top 10,000, current season) refreshes about every
30 minutes. Each run the collector compares every player's `rankScore` with the
previous leaderboard refresh it saw. A changed score means that player finished
a ranked game in between. "Ruby" = ranks 1–500 (the Ruby league).

The window between two observed refreshes is usually ~30 min but varies (Embark's
servers re-render on their own cycles and GitHub's scheduler slips). To compare windows, the page
estimates how many players are in ranked right now:

    est = count * max(1, 30 / minutes)

(a ranked tournament takes roughly 30 min, so a 10‑min window catches ~1/3 of
the people playing; a 60‑min window catches each of them about once).
`share = ruby / all` needs no scaling. Ignore samples with `minutes > 120`
for averages.

## `docs/data/latest.json`

```jsonc
{
  "generatedAt": "2026-10-05T16:10:00Z",      // when the collector last ran
  "season": "s11",
  "leaderboardUpdatedAt": "2026-10-05T16:06:02Z", // Embark's own refresh time
  "window": {                                  // null until two refreshes seen
    "from": "2026-10-05T15:56:02Z",
    "to":   "2026-10-05T16:06:02Z",
    "minutes": 10.0
  },
  "rubyActive": 37,        // Ruby players who finished a ranked game in window
  "allActive": 812,        // same, across the whole top 10k
  "rubyShare": 0.0456,     // rubyActive / allActive (null if allActive == 0)
  "steamPlayers": 10525,   // Steam concurrent players, all modes (null if unavailable)
  "rubyCutoff": 55611,     // rankScore of rank #500
  "grinding": [            // Ruby players active in window, sorted by rank
    { "rank": 3, "name": "Player#1234", "delta": 120, "rankScore": 70120,
      "club": "ABC", "twitch": "somelogin" }   // twitch: login if live right now, else null
  ],
  "twitch": {
    "enabled": true,                 // false => credentials not set; other keys absent
    "checkedAt": "2026-10-05T16:10:00Z",
    "totalStreams": 412,             // all live THE FINALS streams
    "rubyLive": [                    // live streamers matched to a Ruby player
      { "login": "balise", "displayName": "Balise", "title": "...",
        "viewers": 1532, "startedAt": "2026-10-05T13:02:11Z",
        "thumbnail": "https://static-cdn.jtvnw.net/previews-ttv/live_user_balise-{width}x{height}.jpg",
        "rank": 2, "name": "Balise#2431", "rankScore": 71092,
        "matchedBy": "name" }        // "name" (auto) or "alias" (aliases.json)
    ],
    "titleMentions": [               // unmatched live streams whose title says Ruby / top 500
      { "login": "x", "displayName": "X", "title": "RUBY grind", "viewers": 40,
        "startedAt": "...", "thumbnail": "..." }
    ]
  }
}
```

## `docs/data/samples.json`

Rolling 35 days, one row per observed leaderboard refresh window, oldest first.

```jsonc
{
  "fields": ["t", "minutes", "ruby", "all", "steam", "twitchRuby"],
  "rows": [
    [1791215762, 10.0, 37, 812, 10525, 4]   // t = window end (unix seconds, UTC)
  ]
}
```

`steam` and `twitchRuby` may be `null`.

## Regions (added 2026-10-05)

The leaderboard has no region, so the collector places each player by *when*
they play. Each player gets a 24-bucket UTC-hour histogram of the windows where
their score changed, stored under a keyed hash of their name (secret
`REGION_KEY`; the public repo never links names to play times). The
histogram is compared with three evening-shaped templates: Americas (`am`,
UTC−3…−7), Europe/Middle East (`eu`, UTC+1…+3) and Asia-Pacific (`ap`,
UTC+8…+11). A player is "placed" once they've been seen in ≥5 windows and
one region is clearly most likely. Unplaced players are left out of the
regional numbers.

`latest.json` gains (or `"regions": null` when the key isn't set):

```jsonc
"regions": {
  "ready": false,                 // true once >= 250 of the current top 500 are placed
  "placed": { "ruby": 120, "all": 2100 },          // placed players: current Ruby / whole top 10k
  "rubyByRegion": { "am": 60, "eu": 50, "ap": 10 }, // where the placed current-Ruby players are
  "window": {                     // the latest window's active players, by region
    "am": { "ruby": 9, "all": 80 },
    "eu": { "ruby": 15, "all": 90 },
    "ap": { "ruby": 1, "all": 10 },
    "unplaced": { "ruby": 5, "all": 44 }
  }                                // null when `window` is null
}
```

`samples.json` `fields` becomes
`["t","minutes","ruby","all","steam","twitchRuby","amRuby","amAll","euRuby","euAll","apRuby","apAll"]`.
The regional values are `null` in rows from before regions existed (old rows
are padded). Americas share for a row = `amRuby / amAll`.

## Lobby log API (Cloudflare Worker, added 2026-10-05)

`docs/config.js` sets `window.RUBY_RADAR_API` to the Worker's base URL
(empty string = not connected yet; the page then shows the lobby buttons
disabled with a short note).

Every `/api/*` request sends the header `X-Squad-Code: <code>`; a wrong or
missing code gets `401 {"error":"bad squad code"}`. The page asks for the code
and the tapper's name once and keeps them in localStorage (only those two —
the log itself lives in Cloudflare D1).

CORS allows `https://natanforestree.github.io` and `http://localhost:*`
(headers `Content-Type, X-Squad-Code`; methods `GET, POST, DELETE, OPTIONS`).

| Method + path | Body / query | Returns |
| --- | --- | --- |
| `GET /api/ping` | – | `200 {"ok":true}` (used to check a code) |
| `POST /api/lobby` | JSON below | `201 {"id":12,"t":1791221331}`; `429` if the same `who` posted < 30 s ago; `400` on bad input |
| `DELETE /api/lobby/:id` | – | `200 {"ok":true}` (undo) / `404` |
| `GET /api/lobbies` | optional `?since=<unix s>` | `200 {"lobbies":[ …rows, oldest first ]}` |

Lobby row (POST body; the server adds `id` and `t` = server time, unix seconds):

```jsonc
{
  "who": "Nathan",                // 1–24 chars
  "result": "sweaty",             // "sweaty" | "normal"
  "verdict": "wait",              // what the page showed: "queue" | "coin" | "wait" | "calibrating" | "stale" | "unknown"
  "view": "am",                   // which view the verdict used: "am" | "global"
  "share": 0.152,                 // the share that verdict used (null if none)
  "globalShare": 0.134,           // latest global Ruby share (null if none)
  "amShare": 0.171,               // latest Americas Ruby share (null if none)
  "lbUpdatedAt": "2026-10-05T17:28:51Z" // latest.json leaderboardUpdatedAt (null if none)
}
```

The Worker also has a cron trigger every 10 minutes that asks GitHub to run
the `collect` workflow (secret `GITHUB_TOKEN`: fine-grained, this repo only,
Actions read/write). The collector backs the lobby log up into the repo
encrypted (`state/lobbies.json.enc`, AES-256 via openssl, key in the
`BACKUP_KEY` secret) whenever it changes.
