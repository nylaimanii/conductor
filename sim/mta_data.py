"""
Real MTA station lists and demand for L, G, 7, 1, 6.

Source is data.ny.gov (the STATE open data portal, not the city one):
  stations  39hk-dx4f  MTA Subway Stations
  ridership wujg-7c2s  MTA Subway Hourly Ridership

Fetched once and cached to sim/data/lines.json, which is committed. After
that this runs offline and gives identical numbers every time, so a flaky
network on demo day cannot break the build.

Refresh the cache with:  python mta_data.py --refresh
"""

import argparse
import json
import math
import os
from typing import Dict, List, Optional

from line_config import LineConfig

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "data", "lines.json")

STATIONS_URL = "https://data.ny.gov/resource/39hk-dx4f.json"
RIDERSHIP_URL = "https://data.ny.gov/resource/wujg-7c2s.json"

# one weekday week, morning rush only
RUSH_START_DATE = "2023-10-02T00:00:00"
RUSH_END_DATE = "2023-10-07T00:00:00"
RUSH_HOURS = (7, 9)
RUSH_HOUR_COUNT = 5 * 3  # 5 weekdays x 3 hours

LINES = ["L", "G", "7", "1", "6"]

# Station id prefixes in geographic order along each line. The MTA's
# gtfs_stop_id increments along a line, so sorting within a prefix gives the
# real station order. G is the awkward one: it runs down the Crosstown line,
# crosses at Hoyt-Schermerhorn, then shares the Culver line with the F.
LINE_PREFIX_ORDER = {
    "L": ["L"],
    "G": ["G", "A", "F"],
    "7": ["7"],
    "1": ["1"],
    "6": ["6"],
}

# ---------------------------------------------------------------------
# demand scaling
#
# The real L moves far more people than a toy line with 7 trains of 60 seats
# can. DEMAND_SCALE is one global constant applied to every line, so the
# RELATIVE demand between stations and between lines stays exactly what the
# MTA reports, while the absolute rate lands somewhere this sim can serve.
# Calibrated so the busiest line boards ~97% of arrivals under a
# depart-always policy: any lower and the line saturates, which destroys the
# learning signal, and any higher and there is no crowding pressure at all.
# ---------------------------------------------------------------------
TICK_SECONDS = 10.0
DEMAND_SCALE = 0.035

# Trains in service per line.
#
# Calibrated empirically (calibrate_service.py) as the smallest fleet that
# boards >=97% of arrivals under a depart-always policy. A saturated line is
# useless here: if most passengers can never board, holding cannot help and
# there is nothing to learn.
#
# These are not tuned to flatter the result, they are tuned so each line can
# physically serve its own real demand. The spread is real: the 7 and the 1
# carry roughly three times the G's ridership and get proportionally more
# service, which is exactly what the MTA does.
SERVICE_LEVEL = {"L": 7, "G": 6, "7": 12, "1": 16, "6": 16}

# schematic layout
CANVAS_W = 1000.0
CANVAS_H = 620.0
PADDING = 45.0
SEGMENT_LEN = 34.0


# =====================================================================
# fetching
# =====================================================================

def _fetch_json(url: str, params: dict) -> list:
    import requests
    r = requests.get(url, params=params, timeout=120)
    r.raise_for_status()
    return r.json()


def _fetch_stations() -> list:
    return _fetch_json(STATIONS_URL, {
        "$limit": 2000,
        "$select": ("gtfs_stop_id,complex_id,stop_name,daytime_routes,"
                    "gtfs_latitude,gtfs_longitude,borough"),
    })


def _fetch_ridership() -> Dict[str, float]:
    rows = _fetch_json(RIDERSHIP_URL, {
        "$select": "station_complex_id,sum(ridership) as riders",
        "$where": (
            f"transit_timestamp >= '{RUSH_START_DATE}' "
            f"AND transit_timestamp < '{RUSH_END_DATE}' "
            f"AND date_extract_hh(transit_timestamp) "
            f"between {RUSH_HOURS[0]} and {RUSH_HOURS[1]}"
        ),
        "$group": "station_complex_id",
        "$limit": 2000,
    })
    return {r["station_complex_id"]: float(r["riders"]) for r in rows}


def _sort_key(stop_id: str, prefix_order: List[str]):
    prefix = stop_id[0]
    rank = prefix_order.index(prefix) if prefix in prefix_order else 99
    digits = "".join(c for c in stop_id[1:] if c.isdigit())
    return (rank, int(digits) if digits else 0)


def refresh_cache() -> dict:
    """Pull from data.ny.gov and write the cache. Needs network."""
    print("fetching stations from data.ny.gov ...")
    stations = _fetch_stations()
    print(f"  {len(stations)} stations")

    print("fetching rush hour ridership ...")
    riders = _fetch_ridership()
    print(f"  {len(riders)} station complexes")

    out = {
        "_source": "data.ny.gov 39hk-dx4f + wujg-7c2s",
        "_rush_window": f"{RUSH_START_DATE}..{RUSH_END_DATE} "
                        f"hours {RUSH_HOURS[0]}-{RUSH_HOURS[1]}",
        "lines": {},
    }

    for line in LINES:
        order = LINE_PREFIX_ORDER[line]
        picked = [s for s in stations
                  if line in s.get("daytime_routes", "").split()
                  and s["gtfs_stop_id"][0] in order]
        picked.sort(key=lambda s: _sort_key(s["gtfs_stop_id"], order))

        recs = []
        missing = 0
        for s in picked:
            cid = s.get("complex_id")
            r = riders.get(cid)
            if r is None:
                missing += 1
                r = 0.0
            recs.append({
                "stop_id": s["gtfs_stop_id"],
                "name": s["stop_name"],
                "lat": float(s["gtfs_latitude"]),
                "lon": float(s["gtfs_longitude"]),
                "rush_riders": r,
            })

        out["lines"][line] = recs
        print(f"  {line}: {len(recs)} stations, "
              f"{missing} without ridership, "
              f"{recs[0]['name']} -> {recs[-1]['name']}")

    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    with open(CACHE, "w") as f:
        json.dump(out, f, indent=1)
    print(f"wrote {CACHE}")
    return out


def load_cache() -> dict:
    if not os.path.exists(CACHE):
        raise FileNotFoundError(
            f"no cached MTA data at {CACHE}. "
            f"run: python mta_data.py --refresh"
        )
    with open(CACHE) as f:
        return json.load(f)


# =====================================================================
# schematic layout, 45 and 90 degree angles only
# =====================================================================

def schematic_layout(lat_lon: List[tuple]) -> List[tuple]:
    """
    Turn real coordinates into a subway-map style schematic.

    Every segment is snapped to one of the 8 compass directions, so the
    result only ever uses 45 and 90 degree angles while still following the
    real shape of the line. Equal spacing between stations, like a real
    transit diagram. The web side draws these coordinates directly and does
    no layout math of its own.
    """
    if not lat_lon:
        return []

    # local planar projection, good enough over one city
    lat0 = sum(p[0] for p in lat_lon) / len(lat_lon)
    k = math.cos(math.radians(lat0))
    pts = [(lon * k, lat) for lat, lon in lat_lon]

    xy = [(0.0, 0.0)]
    for i in range(1, len(pts)):
        dx = pts[i][0] - pts[i - 1][0]
        dy = pts[i][1] - pts[i - 1][1]
        if dx == 0 and dy == 0:
            ang = 0.0
        else:
            ang = math.atan2(dy, dx)
        # snap to nearest 45 degrees
        snapped = round(ang / (math.pi / 4)) * (math.pi / 4)
        px, py = xy[-1]
        xy.append((px + SEGMENT_LEN * math.cos(snapped),
                   py + SEGMENT_LEN * math.sin(snapped)))

    xs = [p[0] for p in xy]
    ys = [p[1] for p in xy]
    minx, maxx = min(xs), max(xs)
    miny, maxy = min(ys), max(ys)
    w = max(1e-6, maxx - minx)
    h = max(1e-6, maxy - miny)

    scale = min((CANVAS_W - 2 * PADDING) / w, (CANVAS_H - 2 * PADDING) / h)

    out = []
    for x, y in xy:
        cx = PADDING + (x - minx) * scale
        # flip y: geographic north is up, canvas y grows downward
        cy = PADDING + (maxy - y) * scale
        out.append((round(cx, 1), round(cy, 1)))
    return out


# =====================================================================
# building LineConfigs
# =====================================================================

def _n_trains_for(cycle_length: float, speed: float,
                  target_headway_ticks: float = 25.0) -> int:
    """Enough trains to give a sane starting headway on a line this long."""
    spacing = target_headway_ticks * speed
    return max(3, int(round(cycle_length / spacing)))


def build_line_config(line: str, data: Optional[dict] = None,
                      episode_ticks: int = 900) -> LineConfig:
    data = data or load_cache()
    recs = data["lines"][line]

    names = [r["name"] for r in recs]
    xy = schematic_layout([(r["lat"], r["lon"]) for r in recs])

    # riders over the whole rush window -> arrivals per tick per station
    per_tick = []
    for r in recs:
        per_hour = r["rush_riders"] / RUSH_HOUR_COUNT
        rate = per_hour / (3600.0 / TICK_SECONDS) * DEMAND_SCALE
        per_tick.append(round(rate, 5))

    # a station with no reported ridership would silently become a dead stop,
    # so give it the line's floor rather than zero
    nonzero = [r for r in per_tick if r > 0]
    floor = min(nonzero) if nonzero else 0.01
    per_tick = [r if r > 0 else floor for r in per_tick]

    speed = 0.25
    cycle = 2.0 * (len(names) - 1)

    return LineConfig(
        name=line,
        station_names=names,
        station_xy=xy,
        arrival_rates=per_tick,
        n_trains=SERVICE_LEVEL.get(line, _n_trains_for(cycle, speed)),
        capacity=60,
        speed=speed,
        episode_ticks=episode_ticks,
    )


def all_line_configs(episode_ticks: int = 900) -> Dict[str, LineConfig]:
    data = load_cache()
    return {ln: build_line_config(ln, data, episode_ticks) for ln in LINES}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true",
                    help="re-fetch from data.ny.gov and rewrite the cache")
    args = ap.parse_args()

    if args.refresh:
        refresh_cache()

    print("\nline configs:")
    for ln, cfg in all_line_configs().items():
        tot = sum(cfg.arrival_rates)
        print(f"  {ln:>1}: {cfg.n_stations:>2} stations  "
              f"{cfg.n_trains:>2} trains  "
              f"demand {tot:6.3f} pax/tick  "
              f"cycle {cfg.cycle_length:.0f}  "
              f"headway {cfg.mean_headway / cfg.speed:5.1f} ticks")
        print(f"      {cfg.station_names[0]} -> {cfg.station_names[-1]}")
