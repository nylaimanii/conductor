"""
Sanity check the real MTA line configs before training anything.

Three things must hold:
  1. no line is saturated. if most passengers never board, holding cannot
     help and there is no learning signal.
  2. bunching actually emerges under a depart-always policy, otherwise
     there is nothing for the policy to fix.
  3. the schematic layout has no two stations on the same pixel.
"""

import numpy as np

from headway_env import HeadwayEnv
from mta_data import all_line_configs

SEEDS = [0, 1, 2]


def run(cfg, policy, seed):
    env = HeadwayEnv(cfg, seed=seed)
    obs, _ = env.reset(seed=seed)
    while env.agents:
        acts = {a: policy(obs[a]) for a in env.agents}
        obs, _, _, trunc, _ = env.step(acts)
        if any(trunc.values()):
            break
    return env.summary()


def depart_always(o):
    return 0


def hold_if_caught_up(o):
    """Reference control law: gap ahead below even spacing means fall back."""
    return 1 if o[2] * 3.0 < 0.9 else 0


def check_layout(cfg):
    pts = cfg.station_xy
    dupes = len(pts) - len(set(pts))
    mind = min(
        np.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1])
        for i in range(len(pts)) for j in range(i + 1, len(pts))
    )
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return dupes, mind, (min(xs), max(xs), min(ys), max(ys))


if __name__ == "__main__":
    cfgs = all_line_configs()

    print("=" * 74)
    print("LAYOUT")
    print("=" * 74)
    for ln, cfg in cfgs.items():
        dupes, mind, box = check_layout(cfg)
        flag = "  <-- OVERLAP" if dupes or mind < 8 else ""
        print(f"  {ln:>1}: {cfg.n_stations:>2} stations  dupes={dupes}  "
              f"min_sep={mind:5.1f}px  "
              f"x[{box[0]:.0f},{box[1]:.0f}] y[{box[2]:.0f},{box[3]:.0f}]{flag}")

    print()
    print("=" * 74)
    print("DEMAND CALIBRATION AND BUNCHING")
    print("=" * 74)
    print(f"  {'line':<5} {'policy':<14} {'boarded':>14} {'mean_wait':>10} "
          f"{'cv':>7} {'stranded':>9}")
    for ln, cfg in cfgs.items():
        for label, pol in [("depart_always", depart_always),
                           ("hold_reference", hold_if_caught_up)]:
            rs = [run(cfg, pol, s) for s in SEEDS]
            arrived = np.mean([r["arrived"] for r in rs])
            boarded = np.mean([r["boarded"] for r in rs])
            frac = 100.0 * boarded / max(1, arrived)
            mw = np.mean([r["mean_wait"] for r in rs])
            cv = np.mean([r["headway_cv"] for r in rs])
            st = np.mean([r["stranded_events"] for r in rs])
            flag = ""
            if label == "depart_always":
                if frac < 90:
                    flag = "  <-- SATURATED"
                elif cv < 0.25:
                    flag = "  <-- NO BUNCHING"
            print(f"  {ln:<5} {label:<14} {boarded:6.0f}/{arrived:<6.0f} "
                  f"{frac:4.0f}% {mw:10.2f} {cv:7.3f} {st:9.0f}{flag}")
        print()
