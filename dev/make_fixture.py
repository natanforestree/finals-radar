#!/usr/bin/env python3
"""Write synthetic latest.json + samples.json for testing the Ruby Radar page.

Stdlib only. Times are relative to "now", so regenerate before testing
(the page flags data older than 45 min as stale).

    python3 dev/make_fixture.py                 # dev/fixture/ and dev/fixture-new/
    python3 dev/make_fixture.py --only full     # just dev/fixture/
    python3 dev/make_fixture.py --only new --new-window --out /tmp/x
    python3 dev/make_fixture.py --only full --ago 90 --out /tmp/stale

Then serve the repo root and open
    http://localhost:8000/docs/?data=../dev/fixture/
    http://localhost:8000/docs/?data=../dev/fixture-new/

Variants
  full  14 days of windows every ~10-20 min with irregular gaps (two over
        120 min), a daily/weekly rhythm in UTC, Twitch enabled with three
        live Ruby streamers and two title mentions.
  new   "Fresh install": ~3 hours of windows, `window: null` (the collector
        hasn't seen two refreshes yet), Twitch disabled, Steam unavailable.
        --new-window keeps a real window instead, to test the calibrating
        state with raw numbers.
"""

import argparse
import json
import math
import os
import random
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
FIELDS = ["t", "minutes", "ruby", "all", "steam", "twitchRuby"]
RUBY_CUTOFF = 55611


# ---------------------------------------------------------------- the model

def bump(hour, center, width):
    """Gaussian bump on a 24 h circle."""
    d = (hour - center + 12) % 24 - 12
    return math.exp(-0.5 * (d / width) ** 2)


def hour_of(t):
    dt = datetime.fromtimestamp(t, timezone.utc)
    return dt.hour + dt.minute / 60 + dt.second / 3600, dt.weekday()


def players_in_ranked(t):
    """Rough number of top-10k players in a ranked game at time t (UTC)."""
    h, wd = hour_of(t)
    level = (0.20
             + 1.00 * bump(h, 19.5, 3.0)    # EU evening
             + 0.85 * bump(h, 2.0, 3.2)     # NA evening
             + 0.30 * bump(h, 12.5, 2.5))   # Asia/OCE evening
    if wd >= 5:                              # weekend
        level *= 1.18
    if wd == 4 and h >= 17:                  # Friday night
        level *= 1.08
    return 1350 * level


def ruby_share(t):
    """Fraction of active top-10k players who are Ruby (rank 1-500)."""
    h, wd = hour_of(t)
    share = (0.026
             + 0.018 * bump(h, 20.5, 2.4)   # EU evening: pros and scrims
             + 0.015 * bump(h, 3.0, 2.6)    # NA evening
             - 0.012 * bump(h, 15.5, 2.2))  # US morning dip
    if wd >= 5:                              # more casuals at the weekend
        share *= 0.88
    if wd in (1, 3) and 18 <= h <= 23:       # Tue/Thu league nights in EU
        share *= 1.12
    return share


def poissonish(rng, mean):
    if mean <= 0:
        return 0
    return max(0, int(round(rng.gauss(mean, math.sqrt(mean)))))


# ---------------------------------------------------------------- rows

def make_rows(rng, end_t, hours, gaps=(), twitch=True):
    """Windows ending at irregular leaderboard refreshes up to end_t."""
    start = end_t - hours * 3600
    # Build window end times backwards from end_t so the last row lands exactly.
    ends = [end_t]
    gap_iter = sorted(gaps)                       # (hours_before_end, minutes)
    while ends[-1] > start:
        t = ends[-1]
        if gap_iter and (end_t - t) / 3600 >= gap_iter[0][0]:
            step = gap_iter.pop(0)[1] * 60
        else:
            r = rng.random()
            if r < 0.04:
                step = rng.uniform(45, 95) * 60      # scheduler hiccup
            elif r < 0.14:
                step = rng.uniform(21, 40) * 60
            else:
                step = rng.uniform(10, 20) * 60
        ends.append(t - step)
    ends.reverse()                                # oldest first

    day_mood = {}                                 # day-to-day wobble
    rows = []
    for prev, t in zip(ends, ends[1:]):
        minutes = round((t - prev) / 60, 1)
        mid = (prev + t) / 2
        day = int(mid // 86400)
        mood = day_mood.setdefault(day, rng.uniform(0.9, 1.1))
        playing = players_in_ranked(mid) * mood * rng.lognormvariate(0, 0.08)
        caught = min(1.0, minutes / 30)          # a game lasts ~30 min
        all_active = poissonish(rng, playing * caught)
        share = max(0.006, ruby_share(mid) * rng.lognormvariate(0, 0.10))
        ruby = min(all_active, poissonish(rng, all_active * share))
        steam = int(playing * 4.6 * rng.uniform(0.95, 1.05))
        if rng.random() < 0.01:
            steam = None
        tw = None
        if twitch and rng.random() > 0.02:
            tw = max(0, min(9, int(round(share * 90 + rng.gauss(0, 1)))))
        rows.append([int(t), minutes, ruby, all_active, steam, tw])
    return rows


# ---------------------------------------------------------------- latest.json

NAME_BITS = ["Vex", "Nova", "Kilo", "Brisk", "Talon", "Mako", "Juno", "Rook",
             "Pyre", "Onyx", "Sable", "Quill", "Echo", "Drift", "Hex", "Zephyr",
             "Moth", "Lumen", "Grit", "Cobalt", "Rift", "Ash", "Flint", "Wren"]
NAME_TAILS = ["", "", "TTV", "GG", "_fps", "x", "Prime", "Main", "Diff", "Wave"]
# Names that must render literally (escaping / unicode checks).
ODD_NAMES = ["<img src=x onerror=alert(1)>#1337", "Ŝtårlïght#4402",
             "Tom&Jerry#0042", "ナギ#7781"]
CLUBS = ["ABC", "VOID", "GG", "OSPR", "404", "MOTH", "TTV", "NRG"]

LIVE = [
    {"login": "kiwikaboom", "displayName": "KiwiKaboom", "name": "KiwiKaboom#2431",
     "title": "RUBY duos w/ @vaultbreaker | cashouts all day | !sens !crosshair",
     "viewers": 1532, "hoursLive": 3.1, "matchedBy": "name"},
    {"login": "vaultbreaker", "displayName": "VaultBreaker", "name": "Vault#0815",
     "title": "top 50 grind before the season ends",
     "viewers": 286, "hoursLive": 1.4, "matchedBy": "alias"},
    {"login": "lumen_peak", "displayName": "Lumen_Peak", "name": "LumenPeak#5120",
     "title": "chill ranked, ask me about heavy builds",
     "viewers": 47, "hoursLive": 0.4, "matchedBy": "name"},
]
MENTIONS = [
    {"login": "radio_rat", "displayName": "radio_rat",
     "title": "<b>RUBY</b> or bust & then sleep (maybe)", "viewers": 61, "hoursLive": 2.2},
    {"login": "pixelpanda", "displayName": "PixelPanda",
     "title": "Top 500 push with viewers | duos", "viewers": 18, "hoursLive": 0.9},
]


def iso(t):
    return datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def rank_score(rank):
    return int(round(RUBY_CUTOFF + 16500 * ((500 - rank) / 499) ** 2.2))


def thumb(login):
    return f"https://static-cdn.jtvnw.net/previews-ttv/live_user_{login}-{{width}}x{{height}}.jpg"


def make_grinding(rng, count):
    ranks = sorted(rng.sample(range(1, 501), count)) if count else []
    used, out = set(), []
    odd = list(ODD_NAMES)
    for rank in ranks:
        if odd and rng.random() < 0.3:
            name = odd.pop(0)
        else:
            while True:
                name = f"{rng.choice(NAME_BITS)}{rng.choice(NAME_TAILS)}#{rng.randint(1000, 9999)}"
                if name not in used:
                    break
        used.add(name)
        delta = rng.randint(40, 190) if rng.random() < 0.7 else -rng.randint(25, 160)
        out.append({
            "rank": rank, "name": name, "delta": delta, "rankScore": rank_score(rank),
            "club": rng.choice(CLUBS) if rng.random() < 0.55 else None,
            "twitch": None,
        })
    return out


def make_twitch(rng, now_t, grinding):
    live = []
    ranks = [2, 37, 214]
    for i, s in enumerate(LIVE):
        rank = ranks[i]
        live.append({
            "login": s["login"], "displayName": s["displayName"], "title": s["title"],
            "viewers": s["viewers"], "startedAt": iso(now_t - s["hoursLive"] * 3600),
            "thumbnail": thumb(s["login"]), "rank": rank, "name": s["name"],
            "rankScore": rank_score(rank), "matchedBy": s["matchedBy"],
        })
    # The first two streamers also finished a game in this window.
    for s in live[:2]:
        if not any(g["rank"] == s["rank"] for g in grinding):
            grinding.append({"rank": s["rank"], "name": s["name"],
                             "delta": rng.randint(60, 150), "rankScore": s["rankScore"],
                             "club": None, "twitch": s["login"]})
        else:
            for g in grinding:
                if g["rank"] == s["rank"]:
                    g.update(name=s["name"], twitch=s["login"])
    grinding.sort(key=lambda g: g["rank"])
    mentions = [{
        "login": m["login"], "displayName": m["displayName"], "title": m["title"],
        "viewers": m["viewers"], "startedAt": iso(now_t - m["hoursLive"] * 3600),
        "thumbnail": thumb(m["login"]),
    } for m in MENTIONS]
    return {"enabled": True, "checkedAt": iso(now_t), "totalStreams": rng.randint(340, 460),
            "rubyLive": live, "titleMentions": mentions}


def make_latest(rng, rows, now_t, window=True, twitch=True, steam=True):
    last = rows[-1] if rows else None
    lb_t = last[0] if last else now_t - 600
    latest = {
        "generatedAt": iso(now_t),
        "season": "s11",
        "leaderboardUpdatedAt": iso(lb_t),
        "window": None,
        "rubyActive": None,
        "allActive": None,
        "rubyShare": None,
        "steamPlayers": None,
        "rubyCutoff": RUBY_CUTOFF,
        "grinding": [],
        "twitch": {"enabled": False},
    }
    if window and last:
        t, minutes, ruby, all_active, steam_n, _ = last
        latest.update({
            "window": {"from": iso(t - minutes * 60), "to": iso(t), "minutes": minutes},
            "rubyActive": ruby,
            "allActive": all_active,
            "rubyShare": round(ruby / all_active, 4) if all_active else None,
        })
        # One grinding entry per Ruby player active in the window, as the
        # collector does. Leave room for the two streamers added below.
        latest["grinding"] = make_grinding(rng, max(0, ruby - (2 if twitch else 0)))
    if steam and last:
        latest["steamPlayers"] = last[4]
    if twitch:
        latest["twitch"] = make_twitch(rng, now_t, latest["grinding"])
        if window and last:
            latest["rubyActive"] = len(latest["grinding"])
            last[2] = latest["rubyActive"]
            all_active = latest["allActive"]
            latest["rubyShare"] = round(last[2] / all_active, 4) if all_active else None
    return latest


# ---------------------------------------------------------------- output

def write(out_dir, latest, rows):
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, "latest.json"), "w", encoding="utf-8") as f:
        json.dump(latest, f, indent=1, ensure_ascii=False)
        f.write("\n")
    with open(os.path.join(out_dir, "samples.json"), "w", encoding="utf-8") as f:
        json.dump({"fields": FIELDS, "rows": rows}, f, separators=(",", ":"))
        f.write("\n")
    usable = [r for r in rows if r[1] <= 120 and r[3] > 0]
    gaps = sum(1 for r in rows if r[1] > 120)
    if usable:
        shares = [r[2] / r[3] for r in usable]
        print(f"{out_dir}: {len(rows)} rows ({len(usable)} usable, {gaps} over 120 min); "
              f"all {min(r[3] for r in usable)}-{max(r[3] for r in usable)}, "
              f"ruby {min(r[2] for r in usable)}-{max(r[2] for r in usable)}, "
              f"share {min(shares):.1%}-{max(shares):.1%}; "
              f"latest ruby={latest['rubyActive']} all={latest['allActive']}")
    else:
        print(f"{out_dir}: {len(rows)} rows")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--only", choices=["full", "new", "both"], default="both")
    ap.add_argument("--out", help="output directory (only with --only full/new)")
    ap.add_argument("--ago", type=float, default=0,
                    help="pretend the collector last ran this many minutes ago (stale testing)")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--new-window", action="store_true",
                    help="fresh-install variant keeps a real window and numbers")
    args = ap.parse_args()
    if args.out and args.only == "both":
        ap.error("--out needs --only full or --only new")

    rng = random.Random(args.seed)
    now_t = int(datetime.now(timezone.utc).timestamp() - args.ago * 60)
    lb_t = now_t - rng.randint(150, 260)          # Embark refreshed a few min earlier

    if args.only in ("full", "both"):
        rows = make_rows(rng, lb_t, 14 * 24, gaps=[(4 * 24 + 7, 152), (9 * 24 + 15, 205)])
        latest = make_latest(rng, rows, now_t)
        write(args.out or os.path.join(HERE, "fixture"), latest, rows)

    if args.only in ("new", "both"):
        rows = make_rows(rng, lb_t, 3, twitch=False)
        latest = make_latest(rng, rows, now_t, window=args.new_window, twitch=False,
                             steam=args.new_window)
        write(args.out or os.path.join(HERE, "fixture-new"), latest, rows)


if __name__ == "__main__":
    main()
