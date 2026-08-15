"""
One measurement pass, one source of truth.

Every number in the stage summary comes from this script so nothing can
drift between tables. Runs 000, the timetable and 012 on all five lines over
the same unseen seeds and reports:

  spacing   headway cv, and how often a big gap opens up
  wait      mean and the full distribution, p50/p90/p95/max, share over 10 min
  crowding  peak onboard and peak queue depth

The gap-frequency stat is the one that measures what a rider on a platform
actually experiences. A mean wait of three minutes made of steady three
minute gaps and one made of alternating one and nine minute gaps are the
same number and a completely different service.

Writes results.json next to this file.
"""

import json
import os

import numpy as np

from baseline import run_baseline
from dump import METRIC_SEEDS, load_policy, run_policy
from headway_env import TICK_SECONDS
from mta_data import LINES, build_line_config

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "results.json")

MIN = TICK_SECONDS / 60.0          # ticks -> real minutes
OVER_10MIN = 10.0 * 60.0 / TICK_SECONDS
BIG_GAP = 2.0                      # multiples of this line's mean headway


def gap_stats(env_factory, seeds):
    """
    Share of train-ticks where the gap to the train ahead exceeds BIG_GAP
    times the line's own mean headway.

    Uses the raw ring gap rather than the observation feature, which is
    clipped at 3x and would blunt the tail.
    """
    big = tot = 0
    worst = 0.0
    for s in seeds:
        env = env_factory(s)
        for ratios in env.gap_log:
            for r in ratios:
                tot += 1
                if r > BIG_GAP:
                    big += 1
                worst = max(worst, r)
    return 100.0 * big / max(1, tot), worst


def measure(cfg, factory, seeds):
    envs = [factory(s) for s in seeds]

    cv = float(np.mean([e.headway_cv() for e in envs]))
    mw = float(np.mean([e.mean_wait() for e in envs]))

    w = np.concatenate([e.all_waits() for e in envs])
    dist = {
        "p50": float(np.percentile(w, 50)),
        "p90": float(np.percentile(w, 90)),
        "p95": float(np.percentile(w, 95)),
        "max": float(w.max()),
        "over_10min_pct": float(100.0 * np.mean(w > OVER_10MIN)),
        "n": int(len(w)),
    }

    peak_on = float(np.mean([max(max(f["onboard"]) for f in e.frames)
                             for e in envs]))
    peak_q = float(np.mean([max(max(f["waiting"]) for f in e.frames)
                            for e in envs]))
    typ_q = float(np.mean([np.mean([max(f["waiting"]) for f in e.frames])
                           for e in envs]))

    gaps = np.concatenate([np.asarray(e.gap_log, dtype=np.float64).ravel()
                           for e in envs])
    # A max over 150k train-ticks is one sample and moves seed to seed.
    # Percentiles and threshold shares are what actually hold up.
    gap = {
        "p50": float(np.percentile(gaps, 50)),
        "p90": float(np.percentile(gaps, 90)),
        "p99": float(np.percentile(gaps, 99)),
        "max": float(gaps.max()),
        "over_1_25x": float(100.0 * np.mean(gaps > 1.25)),
        "over_1_5x": float(100.0 * np.mean(gaps > 1.5)),
        "over_2x": float(100.0 * np.mean(gaps > BIG_GAP)),
        "n": int(len(gaps)),
    }
    big = int((gaps > BIG_GAP).sum())
    tot = len(gaps)
    worst = float(gaps.max())

    return {
        "gap": gap,
        "cv": cv,
        "mean_wait_ticks": mw,
        "mean_wait_min": mw * MIN,
        "dist_ticks": dist,
        "dist_min": {k: (v * MIN if k not in ("over_10min_pct", "n") else v)
                     for k, v in dist.items()},
        "peak_onboard": peak_on,
        "peak_queue": peak_q,
        "typical_queue": typ_q,
        "big_gap_pct": 100.0 * big / max(1, tot),
        "worst_gap_ratio": worst,
        "train_ticks": tot,
    }


def main():
    m000 = load_policy("L", "000")
    m012 = load_policy("L", "012")
    seeds = METRIC_SEEDS

    out = {"tick_seconds": TICK_SECONDS, "seeds": list(seeds),
           "big_gap_threshold": BIG_GAP, "lines": {}}

    for ln in LINES:
        cfg = build_line_config(ln)
        pols = {
            "000": lambda s, c=cfg: run_policy(c, m000, s, record=True),
            "timetable": lambda s, c=cfg: run_baseline(c, s, record=True),
            "012": lambda s, c=cfg: run_policy(c, m012, s, record=True),
        }
        out["lines"][ln] = {k: measure(cfg, f, seeds) for k, f in pols.items()}
        r = out["lines"][ln]
        print(f"  {ln}: cv {r['000']['cv']:.3f}/{r['timetable']['cv']:.3f}/"
              f"{r['012']['cv']:.3f}  "
              f"big-gap {r['000']['big_gap_pct']:.1f}%/"
              f"{r['timetable']['big_gap_pct']:.1f}%/"
              f"{r['012']['big_gap_pct']:.1f}%", flush=True)

    with open(OUT, "w") as f:
        json.dump(out, f, indent=1)
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
