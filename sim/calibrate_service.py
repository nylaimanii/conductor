"""
Derives SERVICE_LEVEL in mta_data.py.

For each line, finds the smallest fleet that boards at least 97% of arrivals
under a depart-always policy. Below that the line is saturated, most people
never get on, and no holding policy can help.

This is a one time calibration. Re-run it if DEMAND_SCALE, speed, board_rate
or capacity change, then paste the numbers into mta_data.SERVICE_LEVEL.
"""

from dataclasses import replace

import numpy as np

from headway_env import HeadwayEnv
from mta_data import LINES, build_line_config, load_cache

TARGET_BOARDING_PCT = 97.0
SEEDS = (0, 1, 2)
MAX_TRAINS = 40


def boarding_pct(cfg) -> float:
    out = []
    for s in SEEDS:
        env = HeadwayEnv(cfg, seed=s)
        obs, _ = env.reset(seed=s)
        while env.agents:
            obs, _, _, trunc, _ = env.step({a: 0 for a in env.agents})
            if any(trunc.values()):
                break
        m = env.summary()
        out.append(100.0 * m["boarded"] / max(1, m["arrived"]))
    return float(np.mean(out))


if __name__ == "__main__":
    data = load_cache()
    print(f"smallest fleet reaching {TARGET_BOARDING_PCT}% boarding\n")
    result = {}
    for line in LINES:
        base = build_line_config(line, data)
        for n in range(3, MAX_TRAINS + 1):
            cfg = replace(base, n_trains=n)
            pct = boarding_pct(cfg)
            if pct >= TARGET_BOARDING_PCT:
                result[line] = n
                print(f"  {line:>1}: n_trains={n:>2}  boarding={pct:5.1f}%  "
                      f"headway={cfg.mean_headway / cfg.speed:5.1f} ticks  "
                      f"demand={sum(cfg.arrival_rates):.2f}/tick")
                break
        else:
            print(f"  {line}: FAILED under {MAX_TRAINS} trains")

    print(f"\nSERVICE_LEVEL = {result}")
