#!/usr/bin/env python3
"""Ruby Radar collector.

Fetches THE FINALS ranked leaderboard, diffs it against the last version seen
to find who just finished a ranked game, checks Twitch for live Ruby players,
and writes docs/data/latest.json + docs/data/samples.json (see
dev/DATA-CONTRACT.md). Stdlib only, so the GitHub Action needs no installs.
"""

import datetime as dt
import gzip
import hashlib
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

import regions

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "docs", "data")
STATE_DIR = os.path.join(ROOT, "state")
ARCHIVE_DIR = os.path.join(ROOT, "archive")
ALIASES_PATH = os.path.join(ROOT, "aliases.json")

EMBARK_URL = "https://id.embark.games/the-finals/leaderboards/{season}"
COMMUNITY_URL = "https://api.the-finals-leaderboard.com/v1/leaderboard/{season}/crossplay"
STEAM_URL = "https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=2073850"
TWITCH_GAME_NAME = "THE FINALS"

RUBY_RANKS = 500
SAMPLE_DAYS = 35
SAMPLE_FIELDS = ["t", "minutes", "ruby", "all", "steam", "twitchRuby",
                 "amRuby", "amAll", "euRuby", "euAll", "apRuby", "apAll"]
USER_AGENT = "ruby-radar/1.0 (+https://github.com/natanforestree/finals-radar)"

# Embark's page stores entries with numeric keys.
EMBARK_KEYS = {"1": "rank", "3": "name", "5": "rankScore",
               "6": "steamName", "7": "psnName", "8": "xboxName", "12": "clubTag"}


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def iso(ts):
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def http(url, headers=None, data=None, timeout=60, retries=2):
    req = urllib.request.Request(url, data=data, headers={
        "User-Agent": USER_AGENT, "Accept-Encoding": "gzip", **(headers or {})})
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read()
                if resp.headers.get("Content-Encoding") == "gzip":
                    body = gzip.decompress(body)
                return body.decode("utf-8")
        except Exception as ex:
            if attempt == retries:
                raise
            log(f"retrying {url.split('?')[0]}: {ex}")
            time.sleep(3 * (attempt + 1))


def read_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path, obj, pretty=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        if pretty:
            json.dump(obj, f, ensure_ascii=False, indent=1)
        else:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    os.replace(tmp, path)


# ---------------------------------------------------------------- leaderboard

def fetch_embark(season):
    """Returns (entries, embark_updated_ts, newest_ranked_season)."""
    html = http(EMBARK_URL.format(season=season))
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', html, re.S)
    if not m:
        raise ValueError("no __NEXT_DATA__ on Embark page")
    props = json.loads(m.group(1))["props"]["pageProps"]
    entries = [{field: e.get(key, "") for key, field in EMBARK_KEYS.items()} for e in props["entries"]]
    ranked = [lb for lb in props.get("leaderboards", []) if lb.get("kind") == 1]
    newest = max(ranked, key=lambda lb: lb.get("season", 0))["id"] if ranked else season
    updated = props.get("lastUpdatedAt")
    return entries, (updated / 1000 if updated else None), newest


def fetch_community(season):
    data = json.loads(http(COMMUNITY_URL.format(season=season)))
    entries = [{k: e.get(k, "") for k in EMBARK_KEYS.values()} for e in data["data"]]
    return entries, None, season


EMBARK_FETCHES = 4


def fetch_embark_freshest(season):
    """Embark serves the page from several servers, each re-rendering on its
    own ~15 min cycle, so one request can return data 15+ min older than the
    next. Ask a few times and keep the newest data; date it by the earliest
    render that already contained it (closest to when it really changed)."""
    renders = []
    for i in range(EMBARK_FETCHES):
        try:
            renders.append(fetch_embark(season))
        except Exception as ex:
            if i == EMBARK_FETCHES - 1 and not renders:
                raise
            log(f"Embark fetch {i + 1} failed: {ex}")
    digest = lambda r: hashlib.sha1(repr(sorted((e["name"], e["rankScore"]) for e in r[0])).encode()).hexdigest()
    newest = max(renders, key=lambda r: r[1] or 0)
    same = [r for r in renders if digest(r) == digest(newest)]
    first_seen = min((r[1] for r in same if r[1]), default=None)
    log(f"Embark renders: {sorted({iso(r[1]) for r in renders if r[1]})}; using data first seen {first_seen and iso(first_seen)}")
    return newest[0], first_seen, newest[2]


def fetch_leaderboard(season):
    try:
        entries, updated, newest = fetch_embark_freshest(season)
        if newest != season:
            log(f"new ranked season {newest} (was {season})")
            season = newest
            entries, updated, _ = fetch_embark_freshest(season)
        source = "embark"
    except Exception as ex:
        log(f"Embark fetch failed ({ex}); falling back to community API")
        entries, updated, _ = fetch_community(season)
        source = "community"
    entries = [e for e in entries if e["name"] and isinstance(e["rankScore"], int)]
    if len(entries) < 100:
        raise ValueError(f"leaderboard looks broken: {len(entries)} entries")
    return season, entries, updated, source


def load_scores(season):
    meta = read_json(os.path.join(STATE_DIR, "meta.json"), {})
    if meta.get("season") != season:
        return meta, None
    scores = {}
    try:
        with open(os.path.join(STATE_DIR, "scores.tsv"), encoding="utf-8") as f:
            for line in f:
                name, _, score = line.rstrip("\n").rpartition("\t")
                if name:
                    scores[name] = int(score)
    except FileNotFoundError:
        return meta, None
    return meta, scores


def save_scores(entries):
    path = os.path.join(STATE_DIR, "scores.tsv")
    os.makedirs(STATE_DIR, exist_ok=True)
    # One sorted line per player keeps git diffs (and repo growth) small.
    lines = sorted(f"{e['name']}\t{e['rankScore']}\n" for e in entries)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        f.writelines(lines)
    os.replace(path + ".tmp", path)


# --------------------------------------------------------------------- steam

def fetch_steam():
    try:
        return json.loads(http(STEAM_URL, timeout=20))["response"]["player_count"]
    except Exception as ex:
        log(f"Steam fetch failed: {ex}")
        return None


# -------------------------------------------------------------------- twitch

# "TTV"/"twitch" tags can be glued on ("TTVBalise"); shorter tags need a separator.
TAG_PREFIX = re.compile(r"^(?:free)?(?:(?:ttv|twitch(?:tv)?)[\W_]*|(?:yt|tv)[\W_]+)+")
TAG_SUFFIX = re.compile(r"(?:[\W_]*(?:ttv|twitch(?:tv)?)|[\W_]+(?:yt|tv|live))+$")
TITLE_RUBY = re.compile(r"\bruby\b|\btop\s*-?\s*500\b|\btop\s*-?\s*100\b", re.I)


def name_keys(*names):
    """Normalised forms of a player's names for matching Twitch logins."""
    keys = set()
    for n in names:
        if not n:
            continue
        raw = n.split("#")[0].lower()
        for k in (raw, TAG_SUFFIX.sub("", TAG_PREFIX.sub("", raw))):
            k = re.sub(r"[^a-z0-9]", "", k)
            if len(k) >= 4:
                keys.add(k)
    return keys


def twitch_token(client_id, secret):
    body = urllib.parse.urlencode({"client_id": client_id, "client_secret": secret,
                                   "grant_type": "client_credentials"}).encode()
    return json.loads(http("https://id.twitch.tv/oauth2/token", data=body))["access_token"]


def fetch_twitch_streams(client_id, secret, state):
    token = twitch_token(client_id, secret)
    headers = {"Client-Id": client_id, "Authorization": f"Bearer {token}"}
    game_id = state.get("twitchGameId")
    if not game_id:
        q = urllib.parse.quote(TWITCH_GAME_NAME)
        games = json.loads(http(f"https://api.twitch.tv/helix/games?name={q}", headers=headers))["data"]
        if not games:
            raise ValueError("Twitch game not found")
        game_id = state["twitchGameId"] = games[0]["id"]
    streams, cursor = [], None
    for _ in range(15):  # 1,500 streams is far more than THE FINALS ever has live
        url = f"https://api.twitch.tv/helix/streams?game_id={game_id}&first=100&type=live"
        if cursor:
            url += f"&after={cursor}"
        page = json.loads(http(url, headers=headers))
        streams += page["data"]
        cursor = page.get("pagination", {}).get("cursor")
        if not cursor or not page["data"]:
            break
    return streams


def stream_card(s):
    return {"login": s["user_login"], "displayName": s["user_name"], "title": s.get("title", ""),
            "viewers": s.get("viewer_count", 0), "startedAt": s.get("started_at"),
            "thumbnail": s.get("thumbnail_url", "")}


def match_twitch(streams, ruby_entries, aliases):
    by_key = {}
    for e in ruby_entries:
        if e["name"] in aliases and not aliases[e["name"]]:
            continue  # aliases.json maps a wrong auto-match to null
        for k in name_keys(e["name"], e["steamName"], e["psnName"], e["xboxName"]):
            by_key.setdefault(k, e)
    by_alias = {login.lower(): name for name, login in aliases.items() if login}
    by_name = {e["name"]: e for e in ruby_entries}

    ruby_live, mentions, seen = [], [], set()
    for s in sorted(streams, key=lambda s: -s.get("viewer_count", 0)):
        login = s["user_login"].lower()
        entry, how = None, None
        if login in by_alias and by_alias[login] in by_name:
            entry, how = by_name[by_alias[login]], "alias"
        else:
            for k in name_keys(s["user_login"], s["user_name"]):
                if k in by_key:
                    entry, how = by_key[k], "name"
                    break
        if entry and entry["name"] not in seen:
            seen.add(entry["name"])
            ruby_live.append({**stream_card(s), "rank": entry["rank"], "name": entry["name"],
                              "rankScore": entry["rankScore"], "matchedBy": how})
        elif not entry and TITLE_RUBY.search(s.get("title", "")):
            mentions.append(stream_card(s))
    ruby_live.sort(key=lambda r: r["rank"])
    return ruby_live, mentions[:12]


def check_twitch(ruby_entries, state, now):
    client_id = os.environ.get("TWITCH_CLIENT_ID", "").strip()
    secret = os.environ.get("TWITCH_CLIENT_SECRET", "").strip()
    if not client_id or not secret:
        return {"enabled": False}
    try:
        streams = fetch_twitch_streams(client_id, secret, state)
    except Exception as ex:
        log(f"Twitch check failed: {ex}")
        return {"enabled": True, "error": str(ex)[:200], "checkedAt": iso(now),
                "totalStreams": None, "rubyLive": [], "titleMentions": []}
    ruby_live, mentions = match_twitch(streams, ruby_entries, read_json(ALIASES_PATH, {}))
    return {"enabled": True, "checkedAt": iso(now), "totalStreams": len(streams),
            "rubyLive": ruby_live, "titleMentions": mentions}


# ---------------------------------------------------------------------- main

def main():
    now = time.time()
    latest_path = os.path.join(DATA_DIR, "latest.json")
    samples_path = os.path.join(DATA_DIR, "samples.json")
    prev_latest = read_json(latest_path, {})
    meta = read_json(os.path.join(STATE_DIR, "meta.json"), {})

    season, entries, embark_updated, source = fetch_leaderboard(meta.get("season") or "s11")
    meta, prev_scores = load_scores(season)
    entries.sort(key=lambda e: e["rank"])
    ruby = [e for e in entries if e["rank"] <= RUBY_RANKS]
    ruby_names = {e["name"] for e in ruby}
    steam = fetch_steam()
    twitch = check_twitch(ruby, meta, now)
    live_by_name = {r["name"]: r["login"] for r in twitch.get("rubyLive", [])}
    region_key = os.environ.get("REGION_KEY", "").strip()
    activity = regions.Activity(os.path.join(STATE_DIR, "activity.tsv"), region_key) if region_key else None

    # Embark's lastUpdatedAt ticks even when no score moved, so a "new
    # version" is one where at least one shared player's score changed.
    changed = {}
    if prev_scores is not None:
        changed = {e["name"]: e["rankScore"] - prev_scores[e["name"]]
                   for e in entries if e["name"] in prev_scores and prev_scores[e["name"]] != e["rankScore"]}
    version_ts = embark_updated or now
    # Embark's CDN edges can serve an older render after a newer one; never
    # step backwards, or reverted scores would count as fresh activity.
    if prev_scores is not None and meta.get("versionTs") and version_ts <= meta["versionTs"]:
        if changed:
            log(f"ignoring older Embark render ({iso(version_ts)} <= {iso(meta['versionTs'])})")
        changed = {}
    is_new_version = prev_scores is None or bool(changed)

    latest = {
        "generatedAt": iso(now),
        "season": season,
        "leaderboardUpdatedAt": prev_latest.get("leaderboardUpdatedAt"),
        "window": prev_latest.get("window"),
        "rubyActive": prev_latest.get("rubyActive"),
        "allActive": prev_latest.get("allActive"),
        "rubyShare": prev_latest.get("rubyShare"),
        "steamPlayers": steam,
        "rubyCutoff": ruby[-1]["rankScore"] if len(ruby) >= RUBY_RANKS else None,
        "grinding": prev_latest.get("grinding", []),
        "twitch": twitch,
        "regions": prev_latest.get("regions") if activity else None,
        "source": source,
    }
    if prev_latest.get("season") != season:
        latest.update(window=None, rubyActive=None, allActive=None, rubyShare=None, grinding=[])
        if latest["regions"]:
            latest["regions"] = {**latest["regions"], "window": None}

    samples = read_json(samples_path, {"fields": SAMPLE_FIELDS, "rows": []})
    if samples.get("fields") != SAMPLE_FIELDS:  # rows from before regions existed
        samples = {"fields": SAMPLE_FIELDS,
                   "rows": [r + [None] * (len(SAMPLE_FIELDS) - len(r)) for r in samples["rows"]]}

    if is_new_version:
        latest["leaderboardUpdatedAt"] = iso(version_ts)
        prev_version_ts = meta.get("versionTs")
        if changed and prev_version_ts:
            minutes = round((version_ts - prev_version_ts) / 60, 1)
            ruby_changed = [n for n in changed if n in ruby_names]
            all_active, ruby_active = len(changed), len(ruby_changed)
            share = round(ruby_active / all_active, 4) if all_active else None
            by_name = {e["name"]: e for e in ruby}
            grinding = [{"rank": by_name[n]["rank"], "name": n, "delta": changed[n],
                         "rankScore": by_name[n]["rankScore"], "club": by_name[n]["clubTag"] or None,
                         "twitch": live_by_name.get(n)} for n in ruby_changed]
            grinding.sort(key=lambda g: g["rank"])
            latest.update(window={"from": iso(prev_version_ts), "to": iso(version_ts), "minutes": minutes},
                          rubyActive=ruby_active, allActive=all_active, rubyShare=share, grinding=grinding)
            twitch_ruby = len(twitch["rubyLive"]) if twitch.get("enabled") and "error" not in twitch else None
            region_cols = [None] * 6
            if activity:
                if minutes <= 90:  # longer gaps blur which hour people played in
                    activity.record(changed, (prev_version_ts + version_ts) / 2)
                latest["regions"] = regions.summarize(activity, entries, ruby_names, changed)
                w = latest["regions"]["window"]
                region_cols = [w[r][k] for r in regions.REGIONS for k in ("ruby", "all")]
            if minutes > 0:
                samples["rows"].append([int(version_ts), minutes, ruby_active, all_active, steam, twitch_ruby,
                                        *region_cols])
            append_archive(version_ts, minutes, ruby_active, all_active, steam, twitch_ruby, region_cols)
            log(f"{season}: {all_active} active in {minutes} min, {ruby_active} Ruby"
                + (f"; regions {latest['regions']['placed']} placed, window {w}" if activity else ""))
        else:
            if activity:
                latest["regions"] = regions.summarize(activity, entries, ruby_names, None)
            log(f"{season}: baseline saved ({len(entries)} players)")
        meta.update(season=season, versionTs=version_ts)
        save_scores(entries)
    else:
        latest["grinding"] = [{**g, "twitch": live_by_name.get(g["name"])} for g in latest["grinding"]]
        log(f"{season}: no score changes since last run")

    cutoff = now - SAMPLE_DAYS * 86400
    samples["rows"] = [r for r in samples["rows"] if r[0] >= cutoff]
    write_json(samples_path, samples)
    write_json(latest_path, latest, pretty=True)
    write_json(os.path.join(STATE_DIR, "meta.json"), meta, pretty=True)
    if activity:
        activity.save(now)


def append_archive(ts, minutes, ruby_active, all_active, steam, twitch_ruby, region_cols):
    """Long-term aggregate history by month (samples.json only keeps 35 days).
    Counts only: a public log of when named players play would be creepy."""
    os.makedirs(ARCHIVE_DIR, exist_ok=True)
    row = {"t": int(ts), "minutes": minutes, "ruby": ruby_active, "all": all_active,
           "steam": steam, "twitchRuby": twitch_ruby}
    if region_cols[0] is not None:
        row.update(zip(SAMPLE_FIELDS[6:], region_cols))
    path = os.path.join(ARCHIVE_DIR, dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m") + ".jsonl")
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(row, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
