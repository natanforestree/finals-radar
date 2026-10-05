# Ruby Radar

**Is it safe to queue?** A fan-made tracker for THE FINALS ranked that guesses
when the top 500 (Ruby league) are grinding, so you can queue when they aren't.

Live: https://natanforestree.github.io/finals-radar/

## How it works

Nothing public says who's online or in queue, so this works it out from the
leaderboard:

1. Every ~10 minutes a GitHub Action (`.github/workflows/collect.yml`) runs
   `collector/collect.py`.
2. It downloads Embark's public ranked leaderboard (top 10,000, current season)
   and compares every player's score with the last version it saw. A changed
   score means that player just finished a ranked game.
3. It counts how many of those were Ruby (ranks 1–500) versus the whole top
   10k. That **Ruby share** is the number that matters: when few people are
   queuing, the matchmaker reaches further, so a high Ruby share is when you
   get stomped.
4. If Twitch credentials are set, it also lists live THE FINALS streamers whose
   names match a Ruby player.
5. Results go to `docs/data/`, and the page in `docs/` (GitHub Pages) turns
   them into a verdict, a "next good window" and a weekly heatmap in your
   local time.

Caveats: Embark refreshes the leaderboard about every 30 minutes, so the data
runs ~15–45 minutes behind. It gets useful after about a week.

**Regions.** The leaderboard is global but matchmaking is regional, so the
collector also places each player as Americas, Europe or Asia-Pacific from the
hours they're seen playing (`collector/regions.py`), and the page has an
Americas view. Play-time histograms are stored under an HMAC of the player's
name (the `REGION_KEY` secret), so the repo never links names to play times.
It takes a few days to place most players; it can't tell North from South
America apart, and night owls can be misplaced.

**Lobby log.** The SWEATY / NORMAL LOBBY buttons send what the radar said to a
small Cloudflare Worker (`worker/`, D1 database), so the page can show how
often each verdict really meant sweats. The Worker also nudges GitHub to run
the collector every 10 minutes, because GitHub's own schedule is unreliable.
See `worker/README.md`.

## Turning on the Twitch check

1. Go to https://dev.twitch.tv/console/apps → **Register Your Application**.
   Name: anything (e.g. `ruby-radar`), OAuth Redirect URL: `http://localhost`,
   Category: *Website Integration*, Client type: *Confidential*.
2. Open the app, copy the **Client ID**, click **New Secret** and copy it.
3. Add both as repo secrets (they never appear in the page):

   ```sh
   gh secret set TWITCH_CLIENT_ID -R natanforestree/finals-radar
   gh secret set TWITCH_CLIENT_SECRET -R natanforestree/finals-radar
   ```

The next run picks them up.

If a streamer gets matched to the wrong player (or not at all), edit
`aliases.json`: `{"EmbarkName#1234": "twitchlogin"}` forces a match, and
`{"EmbarkName#1234": null}` stops a wrong one.

## Files

| Path | What |
| --- | --- |
| `collector/collect.py` | the collector (Python stdlib only) |
| `docs/` | the site; `docs/data/` is rewritten every run |
| `state/` | last leaderboard seen, for diffing |
| `archive/` | long-term counts by month (no player names) |
| `art/` | Aseprite Lua scripts + sources for the pixel art in `docs/art/` |
| `worker/` | Cloudflare Worker: lobby log API + 10-minute timer |
| `dev/` | data contract, art manifest, fixture generator, mock lobby API |

Run locally: `python3 collector/collect.py`, then serve the repo root
(`python3 -m http.server`) and open `/docs/`. For fake data:
`python3 dev/make_fixture.py`, then `/docs/?data=../dev/fixture/`. To try the
lobby buttons without the real Worker: `python3 dev/mock_api.py` (squad code
`test-code`) and add `&api=http://localhost:8787`.

Fan-made, not affiliated with Embark Studios.
