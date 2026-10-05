# Data contract: collector → page

The collector (`collector/collect.py`, run by GitHub Actions every ~10 min) writes
two files into `docs/data/`. The page (`docs/index.html`) only reads these two.

All times are UTC. ISO strings look like `2026-10-05T15:56:02Z`.

## How "active" is measured

Embark's ranked leaderboard (top 10,000, current season) refreshes every few
minutes. Each run the collector compares every player's `rankScore` with the
previous leaderboard refresh it saw. A changed score means that player finished
a ranked game in between. "Ruby" = ranks 1–500 (the Ruby league).

The window between two observed refreshes varies (GitHub's scheduler is
irregular: usually 10–20 min, sometimes an hour+). To compare windows, the page
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
