"""Guess where players are from when they play.

The leaderboard has no region, but people mostly play in their own evening,
so the UTC hours a player keeps showing up in give their region away. Each
player gets a 24-bucket histogram of the hours they finished ranked games,
compared against three evening-shaped templates.

Histograms are stored under a keyed hash of the player's name (REGION_KEY
secret), so the public repo never says who plays when.
"""

import hashlib
import hmac
import math
import os

REGIONS = ("am", "eu", "ap")

# How busy each local hour (0-23) is for a typical player: quiet overnight,
# building through the afternoon, peaking in the evening.
LOCAL_HOURS = [7, 5, 3, 1.5, 1, 0.8, 0.8, 1, 1.5, 2, 2.5, 3,
               3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7.5, 8, 8.5, 8.5, 8]

# Where each region's players live, as UTC offsets with rough weights
# (northern summer time; off by an hour in winter, which the templates are
# broad enough to absorb). "am" can't tell North from South America apart.
OFFSETS = {
    "am": {-3: 0.15, -4: 0.40, -5: 0.20, -6: 0.05, -7: 0.20},
    "eu": {1: 0.25, 2: 0.55, 3: 0.20},
    "ap": {8: 0.40, 9: 0.30, 10: 0.20, 11: 0.10},
}

MIN_SLOTS = 6        # hour-slots seen (an hour on a given day counts once) before placing
CONFIDENCE = 0.9     # posterior needed to place them
TEMPER = 0.5         # sessions make hours correlated; don't over-trust them
FORGET_DAYS = 21     # drop histograms of players not seen for this long
READY_RUBY = 250     # placed top-500 players needed before the regional view is trusted


def _template(offsets):
    total = sum(LOCAL_HOURS)
    t = [sum(w * LOCAL_HOURS[(h + off) % 24] for off, w in offsets.items()) / total for h in range(24)]
    # A little probability everywhere, so one odd hour can't rule a region out.
    return [0.92 * p + 0.08 / 24 for p in t]


LOG_TEMPLATES = {r: [math.log(p) for p in _template(OFFSETS[r])] for r in REGIONS}


def classify(counts):
    """Region for a 24-hour histogram, or None if it isn't clear yet."""
    if sum(counts) < MIN_SLOTS:
        return None
    ll = {r: TEMPER * sum(c * lt for c, lt in zip(counts, LOG_TEMPLATES[r])) for r in REGIONS}
    top = max(ll.values())
    weights = {r: math.exp(v - top) for r, v in ll.items()}
    best = max(weights, key=weights.get)
    return best if weights[best] / sum(weights.values()) >= CONFIDENCE else None


class Activity:
    """Per-player hour histograms, keyed by HMAC(REGION_KEY, name)."""

    def __init__(self, path, key):
        self.path, self.key = path, key.encode()
        self.rows = {}  # hid -> [last_hour, counts]
        try:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    hid, last, counts = line.rstrip("\n").split("\t")
                    self.rows[hid] = [int(last), [int(c) for c in counts.split(",")]]
        except FileNotFoundError:
            pass

    def hid(self, name):
        return hmac.new(self.key, name.encode("utf-8"), hashlib.sha256).hexdigest()[:16]

    def record(self, names, ts):
        """Count one finished game per player in the hour containing ts. A
        second window in the same hour of the same day doesn't count again."""
        hour = int(ts // 3600)
        for name in names:
            row = self.rows.setdefault(self.hid(name), [0, [0] * 24])
            if row[0] != hour:
                row[0] = hour
                row[1][hour % 24] += 1

    def regions(self):
        return {hid: r for hid, (_, counts) in self.rows.items() if (r := classify(counts))}

    def save(self, now):
        horizon = int(now // 3600) - FORGET_DAYS * 24
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        lines = sorted(f"{hid}\t{last}\t{','.join(map(str, counts))}\n"
                       for hid, (last, counts) in self.rows.items() if last >= horizon)
        with open(self.path + ".tmp", "w", encoding="utf-8") as f:
            f.writelines(lines)
        os.replace(self.path + ".tmp", self.path)


def summarize(activity, entries, ruby_names, changed_names):
    """The `regions` block for latest.json (see dev/DATA-CONTRACT.md)."""
    placed = activity.regions()
    region_of = {e["name"]: placed.get(activity.hid(e["name"])) for e in entries}
    ruby_by_region = {r: 0 for r in REGIONS}
    for n in ruby_names:
        if region_of.get(n):
            ruby_by_region[region_of[n]] += 1
    window = None
    if changed_names is not None:
        window = {k: {"ruby": 0, "all": 0} for k in (*REGIONS, "unplaced")}
        for n in changed_names:
            k = region_of.get(n) or "unplaced"
            window[k]["all"] += 1
            window[k]["ruby"] += n in ruby_names
    placed_ruby = sum(ruby_by_region.values())
    return {
        "ready": placed_ruby >= READY_RUBY,
        "placed": {"ruby": placed_ruby, "all": sum(1 for r in region_of.values() if r)},
        "rubyByRegion": ruby_by_region,
        "window": window,
    }
