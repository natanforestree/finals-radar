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

Caveats: the data runs ~10–20 minutes behind, and it's global — matchmaking is
regional, so the heatmap mixes regions. It gets useful after about a week.

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
| `dev/` | data contract, art manifest, fixture generator |

Run locally: `python3 collector/collect.py`, then serve the repo root
(`python3 -m http.server`) and open `/docs/`. For fake data:
`python3 dev/make_fixture.py`, then `/docs/?data=../dev/fixture/`.

Fan-made, not affiliated with Embark Studios.
