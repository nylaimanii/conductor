"""
Decision boundary export for the mech-interp visualization.

Sweeps two observation features across a grid, holds the other ten at their
median observed value, and records P(hold) at every grid point. Writes
/web/public/interp/boundary_{TAG}.json.

Two choices worth knowing about:

1. The observation distribution is collected ONLY at decision points, that
   is trains actually dwelling with service finished. P(hold) is
   behaviourally meaningless while a train is in transit because the env
   ignores the action there, so medians taken over all ticks would describe
   a slice the policy never really acts in.

2. Both checkpoints are sliced at the SAME medians and the SAME axes, taken
   from the shipped policy's operating distribution. If each map used its own
   medians the two pictures would differ because the slice moved, not because
   the policy changed, and the comparison would be worthless.

Axes are chosen by measurement, not assumption: every feature is swept alone
and ranked by how much it actually moves P(hold).
"""

import argparse
import json
import os

import numpy as np
import torch

from dump import load_policy
from headway_env import DWELLING, HeadwayEnv, OBS_DIM
from mta_data import build_line_config

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.abspath(
    os.path.join(HERE, "..", "web", "public", "interp")
)

# order matches the observation vector built in headway_env._observe
FEATURE_NAMES = [
    "position_on_line_normalized",
    "direction",
    "headway_ahead_ratio",
    "headway_behind_ratio",
    "onboard_over_capacity",
    "dwell_over_max_dwell",
    "waiting_here_norm",
    "waiting_next_1_norm",
    "waiting_next_2_norm",
    "waiting_next_3_norm",
    "time_of_day_norm",
    "local_crowding_index",
]

GRID_N = 40
SWEEP_N = 64
COLLECT_SEEDS = (100, 101, 102)

# checkpoint step counts, for provenance in the output
CHECKPOINT_STEPS = {"000": 0, "001": 200_032, "003": 600_040,
                    "006": 1_200_024, "012": 2_400_048}


def p_hold(model, obs: np.ndarray) -> np.ndarray:
    """P(hold) for a batch of observations."""
    with torch.no_grad():
        t = torch.as_tensor(np.asarray(obs, dtype=np.float32))
        dist = model.policy.get_distribution(t)
        probs = dist.distribution.probs.detach().numpy()
    return probs[:, 1]


def collect_decision_observations(cfg, model, seeds=COLLECT_SEEDS):
    """
    Observations at real decision points under the shipped policy.

    A decision point is a dwelling train. Those are the only states where
    hold or depart actually changes anything.
    """
    rows = []
    for s in seeds:
        env = HeadwayEnv(cfg, seed=s)
        obs, _ = env.reset(seed=s)
        while env.agents:
            batch = np.stack([obs[a] for a in env.agents])
            for i, a in enumerate(env.agents):
                if env.state[i] == DWELLING:
                    rows.append(batch[i])
            acts, _ = model.predict(batch, deterministic=True)
            obs, _, _, trunc, _ = env.step(
                {a: int(acts[i]) for i, a in enumerate(env.agents)})
            if any(trunc.values()):
                break
    return np.stack(rows)


def rank_features(model, base: np.ndarray, lo: np.ndarray, hi: np.ndarray,
                  obs_lo: np.ndarray, obs_hi: np.ndarray):
    """
    Sweep each feature alone across the full normalized domain and measure
    how much P(hold) moves. This is what picks the axes, instead of guessing.

    Reports both the spread (max minus min) and the standard deviation.
    Spread is the honest headline: a feature can have low variance while
    still flipping the decision hard at one threshold.
    """
    out = []
    for k in range(OBS_DIM):
        grid = np.tile(base, (SWEEP_N, 1))
        grid[:, k] = np.linspace(lo[k], hi[k], SWEEP_N)
        p = p_hold(model, grid)
        out.append({"feature": FEATURE_NAMES[k], "index": k,
                    "p_hold_std": float(p.std()),
                    "p_hold_spread": float(p.max() - p.min()),
                    "swept_min": float(lo[k]),
                    "swept_max": float(hi[k]),
                    "observed_min": float(obs_lo[k]),
                    "observed_max": float(obs_hi[k])})
    out.sort(key=lambda r: r["p_hold_spread"], reverse=True)
    return out


def build_boundary(model, base, lo, hi, ix, iy, n=GRID_N):
    """P(hold) over an n x n grid of the two chosen features."""
    xs = np.linspace(lo[ix], hi[ix], n)
    ys = np.linspace(lo[iy], hi[iy], n)
    grid = np.tile(base, (n * n, 1))
    xx, yy = np.meshgrid(xs, ys, indexing="xy")
    grid[:, ix] = xx.ravel()
    grid[:, iy] = yy.ravel()
    p = p_hold(model, grid).reshape(n, n)
    # row index is y, column index is x
    return xs, ys, p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--line", default="L")
    ap.add_argument("--tags", nargs="*", default=["000", "012"])
    ap.add_argument("--shipped", default="012",
                    help="policy whose operating distribution defines the "
                         "slice and the axes")
    ap.add_argument("--grid", type=int, default=GRID_N)
    ap.add_argument("--out", default=None)
    ap.add_argument("--axes", nargs=2, default=None, metavar="FEATURE",
                    help="force the two axis features instead of using the "
                         "measured top two")
    ap.add_argument("--name", default="boundary",
                    help="output filename prefix, written as "
                         "{name}_{tag}.json")
    ap.add_argument("--pair-id", default="primary",
                    help="identifier for this axis pairing, carried in the "
                         "payload so the web side can tell them apart")
    args = ap.parse_args()

    out_dir = args.out or OUT_DIR
    os.makedirs(out_dir, exist_ok=True)

    cfg = build_line_config(args.line)
    shipped = load_policy(args.line, args.shipped)

    print(f"collecting decision-point observations on line {args.line} "
          f"under the {args.shipped} policy ...")
    obs = collect_decision_observations(cfg, shipped)
    base = np.median(obs, axis=0)
    lo, hi = obs.min(axis=0), obs.max(axis=0)
    print(f"  {len(obs):,} decision points\n")

    # Sweep over the FULL normalized domain, not the observed range.
    #
    # Every feature is constructed to live in [0,1], and the observed range
    # under the shipped policy is badly truncated by its own competence: it
    # keeps headways even, so headway_ahead_ratio only ever spans about
    # [0.24, 0.42] in its own rollouts. Ranking features over a range the
    # good policy never leaves would understate precisely the features that
    # matter, and the boundary map would show a keyhole instead of the
    # decision surface. Observed ranges are still reported per feature as
    # context.
    full_lo = np.zeros(OBS_DIM)
    full_hi = np.ones(OBS_DIM)

    print("feature ranking, P(hold) response when swept alone:")
    print(f"  {'feature':<32} {'spread':>8} {'std':>8}  observed range")
    ranking = rank_features(shipped, base, full_lo, full_hi, lo, hi)
    for r in ranking:
        print(f"  {r['feature']:<32} {r['p_hold_spread']:8.4f} "
              f"{r['p_hold_std']:8.4f}  "
              f"[{r['observed_min']:.3f}, {r['observed_max']:.3f}]")

    if args.axes:
        for name in args.axes:
            if name not in FEATURE_NAMES:
                raise SystemExit(
                    f"unknown feature {name!r}. valid: {FEATURE_NAMES}")
        ix, iy = (FEATURE_NAMES.index(n) for n in args.axes)
        rank_of = {r["feature"]: i + 1 for i, r in enumerate(ranking)}
        print(f"\naxes forced: x={FEATURE_NAMES[ix]} "
              f"(rank {rank_of[FEATURE_NAMES[ix]]}), "
              f"y={FEATURE_NAMES[iy]} "
              f"(rank {rank_of[FEATURE_NAMES[iy]]})\n")
    else:
        top = [r for r in ranking if r["p_hold_spread"] > 0][:2]
        ix, iy = top[0]["index"], top[1]["index"]
        print(f"\nchosen axes: x={FEATURE_NAMES[ix]}  "
              f"y={FEATURE_NAMES[iy]}\n")

    held = {FEATURE_NAMES[k]: round(float(base[k]), 4)
            for k in range(OBS_DIM) if k not in (ix, iy)}

    for tag in args.tags:
        model = load_policy(args.line, tag)
        xs, ys, p = build_boundary(model, base, full_lo, full_hi,
                                   ix, iy, args.grid)

        payload = {
            "tag": tag,
            "label": "untrained" if tag == "000" else "trained",
            "line": args.line,
            "checkpoint_steps": CHECKPOINT_STEPS.get(tag),
            "metric": "p_hold",
            "pair_id": args.pair_id,
            "axis_selection": "forced" if args.axes else "measured_top_two",
            "grid": {"nx": args.grid, "ny": args.grid},
            "x": {"feature": FEATURE_NAMES[ix],
                  "min": round(float(xs[0]), 6),
                  "max": round(float(xs[-1]), 6),
                  "values": [round(float(v), 6) for v in xs]},
            "y": {"feature": FEATURE_NAMES[iy],
                  "min": round(float(ys[0]), 6),
                  "max": round(float(ys[-1]), 6),
                  "values": [round(float(v), 6) for v in ys]},
            # p_hold[j][i] is P(hold) at x = x.values[i], y = y.values[j]
            "p_hold": [[round(float(v), 5) for v in row] for row in p],
            "held_fixed": held,
            "slice_note": (
                "axes swept over the full normalized [0,1] domain. other "
                "features fixed at their median over decision points "
                f"(dwelling trains) under the {args.shipped} policy on line "
                f"{args.line}. both tags use the same slice and axes so the "
                "maps are directly comparable."
            ),
            "observed_range": {
                "x": [round(float(lo[ix]), 4), round(float(hi[ix]), 4)],
                "y": [round(float(lo[iy]), 4), round(float(hi[iy]), 4)],
                "note": ("where the shipped policy actually operates inside "
                         "the swept domain, for shading the in-distribution "
                         "region"),
            },
            "feature_ranking": ranking,
        }

        path = os.path.join(out_dir, f"{args.name}_{tag}.json")
        with open(path, "w") as f:
            json.dump(payload, f, separators=(",", ":"))
        kb = os.path.getsize(path) / 1024.0
        print(f"  {os.path.basename(path):<28} P(hold) "
              f"min={p.min():.3f} max={p.max():.3f} mean={p.mean():.3f}  "
              f"{kb:.0f}KB")


if __name__ == "__main__":
    main()
