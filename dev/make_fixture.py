#!/usr/bin/env python3
"""Write synthetic latest.json + samples.json for testing the Ruby Radar page.

Stdlib only. Times are relative to "now", so regenerate before testing
(the page flags data older than 60 min as stale).

    python3 dev/make_fixture.py                 # every variant below
    python3 dev/make_fixture.py --only full     # just dev/fixture/
    python3 dev/make_fixture.py --only new --new-window --out /tmp/x
    python3 dev/make_fixture.py --only full --ago 90 --out /tmp/stale
    python3 dev/make_fixture.py --only full --regions-off --out /tmp/noregions
    python3 dev/make_fixture.py --only learning --regions-hours 30 --out /tmp/learn30

Then serve the repo root and open
    http://localhost:8000/docs/?data=../dev/fixture/
    http://localhost:8000/docs/?data=../dev/fixture-new/
    http://localhost:8000/docs/?data=../dev/fixture/learning/

Variants
  full      14 days of windows every ~10-20 min with irregular gaps (two over
            120 min), a daily/weekly rhythm in UTC, Twitch enabled with three
            live Ruby streamers and two title mentions. Regions started 10 days
            ago (older rows have null regional fields, like the live data) and
            are ready: about 400 of the top 500 placed. The Americas have their
            own rhythm: the NA evening (UTC 0-5) is the sweaty time, and the
            EU-evening Ruby rush doesn't touch Americas share.
            --regions-off writes `"regions": null` and all-null regional fields
            instead (the collector without REGION_KEY).
  new       "Fresh install": ~3 hours of windows, `window: null` (the collector
            hasn't seen two refreshes yet), Twitch disabled, Steam unavailable,
            regions present but nothing placed yet. --new-window keeps a real
            window instead, to test the calibrating state with raw numbers.
  learning  Same history as full, but regions only started --regions-hours ago
            (default 3), so few players are placed and `ready` is false.
            Written to dev/fixture/learning/ (inside the gitignored fixture dir).
"""

import argparse
import json
import math
import os
import random
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
FIELDS = ["t", "minutes", "ruby", "all", "steam", "twitchRuby",
          "amRuby", "amAll", "euRuby", "euAll", "apRuby", "apAll"]
REGIONS = ("am", "eu", "ap")
RUBY_CUTOFF = 55611


# ---------------------------------------------------------------- the model

def bump(hour, center, width):
    """Gaussian bump on a 24 h circle."""
    d = (hour - center + 12) % 24 - 12
    return math.exp(-0.5 * (d / width) ** 2)


def hour_of(t):
    dt = datetime.fromtimestamp(t, timezone.utc)
    return dt.hour + dt.minute / 60 + dt.second / 3600, dt.weekday()


# Each region's ranked crowd peaks in its own evening, in UTC hours:
# (base, peak, centre, width). Together they make the old global curve.
ACTIVITY = {
    "am": (0.07, 0.85, 2.0, 3.2),    # NA evening (7-11 pm Eastern/Pacific)
    "eu": (0.08, 1.00, 19.5, 3.0),   # EU evening
    "ap": (0.05, 0.30, 12.5, 2.5),   # Asia/OCE evening
}


def players_in_ranked(t, region):
    """Rough number of top-10k players from one region in a ranked game at t (UTC)."""
    h, wd = hour_of(t)
    base, peak, centre, width = ACTIVITY[region]
    level = base + peak * bump(h, centre, width)
    if wd >= 5:                              # weekend
        level *= 1.18
    if wd == 4 and h >= 17:                  # Friday night
        level *= 1.08
    return 1350 * level


def ruby_share(t, region):
    """Fraction of a region's active top-10k players who are Ruby (rank 1-500)."""
    h, wd = hour_of(t)
    if region == "am":
        share = (0.022
                 + 0.030 * bump(h, 2.5, 2.3)     # NA evening: the grinders are all on
                 - 0.010 * bump(h, 17.0, 2.5))   # NA morning dip
        if wd >= 5:
            share *= 0.9
    elif region == "eu":
        share = (0.026
                 + 0.022 * bump(h, 20.5, 2.4)    # EU evening: pros and scrims
                 - 0.008 * bump(h, 9.0, 2.5))
        if wd >= 5:                          # more casuals at the weekend
            share *= 0.88
        if wd in (1, 3) and 18 <= h <= 23:   # Tue/Thu league nights in EU
            share *= 1.12
    else:
        share = 0.018 + 0.010 * bump(h, 13.0, 2.5)
    return share


def placed_fraction(t, regions_start, ruby):
    """Share of active players the collector has placed by time t.

    Ruby players grind more, so they reach the five windows needed sooner."""
    if regions_start is None or t < regions_start:
        return None
    days = (t - regions_start) / 86400
    full, speed = (0.82, 1.6) if ruby else (0.62, 3.0)
    return full * (1 - math.exp(-days / speed))


def thin(rng, n, p):
    """Binomial(n, p), near enough."""
    if n <= 0 or p <= 0:
        return 0
    mean = n * p
    return max(0, min(n, int(round(rng.gauss(mean, math.sqrt(mean * (1 - p)) or 0.0)))))


def poissonish(rng, mean):
    if mean <= 0:
        return 0
    return max(0, int(round(rng.gauss(mean, math.sqrt(mean)))))


# ---------------------------------------------------------------- rows

def make_rows(rng, end_t, hours, gaps=(), twitch=True, regions_start=None):
    """Windows ending at irregular leaderboard refreshes up to end_t.

    Regional fields are None for windows before regions_start (or always,
    when it's None), like rows the collector wrote before region detection."""
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
        caught = min(1.0, minutes / 30)          # a game lasts ~30 min
        per, playing_total = {}, 0.0
        for region in REGIONS:
            playing = players_in_ranked(mid, region) * mood * rng.lognormvariate(0, 0.08)
            playing_total += playing
            active = poissonish(rng, playing * caught)
            share = max(0.004, ruby_share(mid, region) * rng.lognormvariate(0, 0.10))
            per[region] = (min(active, poissonish(rng, active * share)), active)
        ruby = sum(r for r, _ in per.values())
        all_active = sum(a for _, a in per.values())
        steam = int(playing_total * 4.6 * rng.uniform(0.95, 1.05))
        if rng.random() < 0.01:
            steam = None
        tw = None
        if twitch and rng.random() > 0.02:
            share = ruby / all_active if all_active else 0
            tw = max(0, min(9, int(round(share * 90 + rng.gauss(0, 1)))))
        regional = [None] * 6
        f_ruby = placed_fraction(t, regions_start, True)
        if f_ruby is not None:
            f_all = placed_fraction(t, regions_start, False)
            regional = []
            for region in REGIONS:
                r, a = per[region]
                placed_ruby = thin(rng, r, f_ruby)
                regional += [placed_ruby, placed_ruby + thin(rng, a - r, f_all)]
        rows.append([int(t), minutes, ruby, all_active, steam, tw] + regional)
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
        t, minutes, ruby, all_active = last[:4]
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


def make_regions(rng, rows, latest, now_t, regions_start):
    """latest.json `regions` (see "Regions" in dev/DATA-CONTRACT.md)."""
    f_ruby = placed_fraction(now_t, regions_start, True) or 0
    f_all = placed_fraction(now_t, regions_start, False) or 0
    placed_ruby = int(round(500 * f_ruby * rng.uniform(0.97, 1.03)))
    placed_all = int(round(10000 * f_all * rng.uniform(0.97, 1.03)))
    am = int(round(placed_ruby * 0.42))
    ap = int(round(placed_ruby * 0.09))
    regions = {
        "ready": placed_ruby >= 250,
        "placed": {"ruby": placed_ruby, "all": placed_all},
        "rubyByRegion": {"am": am, "eu": placed_ruby - am - ap, "ap": ap},
        "window": None,
    }
    last = rows[-1] if rows else None
    if latest["window"] and last and last[6] is not None:
        # make_latest may have trimmed the global Ruby count to match the
        # grinding list; keep the regional Ruby counts inside it.
        ruby, all_active = latest["rubyActive"] or 0, latest["allActive"] or 0
        while last[6] + last[8] + last[10] > ruby:
            i = max((6, 8, 10), key=lambda k: last[k])
            last[i] -= 1
            last[i + 1] -= 1
        win = {}
        for i, region in enumerate(REGIONS):
            win[region] = {"ruby": last[6 + 2 * i], "all": last[7 + 2 * i]}
        win["unplaced"] = {
            "ruby": ruby - sum(w["ruby"] for w in win.values()),
            "all": all_active - sum(w["all"] for w in win.values()),
        }
        regions["window"] = win
    return regions


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
    am = [r for r in usable if r[6] is not None and r[7]]
    reg = latest.get("regions")
    if reg:
        shares = [r[6] / r[7] for r in am] or [0]
        print(f"  regions: ready={reg['ready']} placed={reg['placed']} byRegion={reg['rubyByRegion']}; "
              f"{len(am)} Americas rows, share {min(shares):.1%}-{max(shares):.1%}; "
              f"window={json.dumps(reg['window'])}")
    else:
        print(f"  regions: {reg!r}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--only", choices=["full", "new", "learning", "all", "both"], default="all",
                    help="which variant to write (both = all, kept for old commands)")
    ap.add_argument("--out", help="output directory (only with a single --only variant)")
    ap.add_argument("--ago", type=float, default=0,
                    help="pretend the collector last ran this many minutes ago (stale testing)")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--new-window", action="store_true",
                    help="fresh-install variant keeps a real window and numbers")
    ap.add_argument("--regions-off", action="store_true",
                    help='full variant: "regions": null and all-null regional fields')
    ap.add_argument("--regions-hours", type=float, default=3,
                    help="learning variant: how long ago region detection started")
    args = ap.parse_args()
    every = args.only in ("all", "both")
    if args.out and every:
        ap.error("--out needs --only full, new or learning")

    rng = random.Random(args.seed)
    now_t = int(datetime.now(timezone.utc).timestamp() - args.ago * 60)
    lb_t = now_t - rng.randint(150, 260)          # Embark refreshed a few min earlier
    gaps = [(4 * 24 + 7, 152), (9 * 24 + 15, 205)]

    if every or args.only == "full":
        start = None if args.regions_off else lb_t - 10 * 86400
        rows = make_rows(rng, lb_t, 14 * 24, gaps=gaps, regions_start=start)
        latest = make_latest(rng, rows, now_t)
        latest["regions"] = None if args.regions_off else make_regions(rng, rows, latest, now_t, start)
        write(args.out or os.path.join(HERE, "fixture"), latest, rows)

    if every or args.only == "new":
        start = lb_t - 3 * 3600
        rows = make_rows(rng, lb_t, 3, twitch=False, regions_start=start)
        latest = make_latest(rng, rows, now_t, window=args.new_window, twitch=False,
                             steam=args.new_window)
        latest["regions"] = make_regions(rng, rows, latest, now_t, start)
        write(args.out or os.path.join(HERE, "fixture-new"), latest, rows)

    if every or args.only == "learning":
        start = lb_t - args.regions_hours * 3600
        rows = make_rows(rng, lb_t, 14 * 24, gaps=gaps, regions_start=start)
        latest = make_latest(rng, rows, now_t)
        latest["regions"] = make_regions(rng, rows, latest, now_t, start)
        write(args.out or os.path.join(HERE, "fixture", "learning"), latest, rows)


if __name__ == "__main__":
    main()
