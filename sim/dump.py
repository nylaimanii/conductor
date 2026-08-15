"""
Trajectory dumper. Writes /web/public/runs/{LINE}_{TAG}.json.

The JSON shape is frozen in /contract.md. sim writes, web reads, neither
side changes it unilaterally. This module is the only place in sim that
writes outside sim, and it writes nothing except those run files.

Metrics note: mean_wait and baseline_wait are averaged over several unseen
seeds, because a single episode is noisy and the metric is a property of the
policy rather than of one lucky rush hour. The animated trajectory is one
representative episode at DUMP_SEED.
"""

import argparse
import json
import os
from typing import Optional

import numpy as np

from baseline import TimetableBaseline, run_baseline
from headway_env import HeadwayEnv
from mta_data import LINES, build_line_config

HERE = os.path.dirname(os.path.abspath(__file__))
CKPT_DIR = os.path.join(HERE, "checkpoints")
OUT_DIR = os.path.abspath(
    os.path.join(HERE, "..", "web", "public", "runs")
)

# seeds the policy never saw in training
DUMP_SEED = 100
METRIC_SEEDS = (100, 101, 102, 103, 104)

SUBSAMPLE = 2  # every 2nd tick, per contract

LABELS = {
    "000": "untrained",
    "001": "1% trained",
    "003": "3% trained",
    "006": "6% trained",
    # 012 is the shipped policy, so it carries the plain "trained" label.
    # It beat 025 on cv on four of five lines and on wait on all five: at 25
    # percent the entropy floor still has the policy over-holding (34.8
    # percent of decisions against 14.0 at 012), which costs passenger wait.
    "012": "trained",
    "baseline": "fixed timetable",
}

# Every line gets the full ladder. Six tags, five lines, thirty files.
#
# Log spaced checkpoints matching CHECKPOINT_FRACTIONS in train.py. The
# ladder sits entirely inside the region where learning actually happens,
# and 025 is the final shipped policy, early stopped at 5,000,000 timesteps.
#
# Every non-baseline tag on G, 7, 1 and 6 is the SAME L-trained checkpoint
# run zero-shot. Nothing is retrained per line.
ALL_TAGS = ["baseline", "000", "001", "003", "006", "012"]
TAGS_BY_LINE = {ln: list(ALL_TAGS) for ln in LINES}


# ---------------------------------------------------------------------
# rollouts
# ---------------------------------------------------------------------

def run_policy(cfg, model, seed: int, record: bool = False) -> HeadwayEnv:
    env = HeadwayEnv(cfg, seed=seed, record=record)
    obs, _ = env.reset(seed=seed)
    while env.agents:
        batch = np.stack([obs[a] for a in env.agents])
        acts, _ = model.predict(batch, deterministic=True)
        actions = {a: int(acts[i]) for i, a in enumerate(env.agents)}
        obs, _, _, trunc, _ = env.step(actions)
        if any(trunc.values()):
            break
    return env


def load_policy(line_trained_on: str, tag: str):
    from stable_baselines3 import PPO
    path = os.path.join(CKPT_DIR, f"{line_trained_on}_{tag}.zip")
    if not os.path.exists(path):
        raise FileNotFoundError(f"missing checkpoint {path}, run train.py")
    return PPO.load(path, device="cpu")


# ---------------------------------------------------------------------
# contract shaping
# ---------------------------------------------------------------------

def build_payload(line: str, tag: str, cfg, frames, mean_wait: float,
                  baseline_wait: float) -> dict:
    """Exactly the shape in /contract.md. Nothing added, nothing renamed."""
    stations = [
        {"name": n, "x": xy[0], "y": xy[1]}
        for n, xy in zip(cfg.station_names, cfg.station_xy)
    ]

    ticks = []
    for f in frames[::SUBSAMPLE]:
        ticks.append({
            "t": f["t"],
            "trains": [
                # pos is a float station index: 3.42 means 42% of the way
                # from station 3 to station 4. rounded to 2dp per contract.
                #
                # obs carries the three normalized features the interp panel
                # plots, exactly as the policy sees them: both headway
                # ratios are gap divided by the line's own mean headway then
                # clipped at 3 and divided by 3, so 0.33 is perfectly even
                # spacing. dwell is ticks dwelled over max_dwell. All three
                # are dimensionless and in [0,1], same 2dp rounding as pos.
                {"pos": round(float(p), 2),
                 "onboard": int(o),
                 "holding": bool(h),
                 "obs": {k: round(float(v), 2) for k, v in ob.items()}}
                for p, o, h, ob in zip(f["pos"], f["onboard"],
                                       f["holding"], f["obs"])
            ],
            "waiting": [int(w) for w in f["waiting"]],
        })

    if baseline_wait > 0:
        improvement = 100.0 * (baseline_wait - mean_wait) / baseline_wait
    else:
        improvement = 0.0

    return {
        "line": line,
        "tag": tag,
        "label": LABELS[tag],
        "capacity": int(cfg.capacity),
        "stations": stations,
        "ticks": ticks,
        "metrics": {
            "mean_wait": round(float(mean_wait), 2),
            "baseline_wait": round(float(baseline_wait), 2),
            "improvement_pct": round(float(improvement), 1),
        },
    }


def validate(payload: dict, cfg):
    """
    Fail loudly here rather than let the web side render nonsense.
    Every one of these is a rule from /contract.md.
    """
    n = cfg.n_stations
    assert set(payload) == {"line", "tag", "label", "capacity", "stations",
                            "ticks", "metrics"}, "top level keys drifted"
    assert len(payload["stations"]) == n
    for s in payload["stations"]:
        assert set(s) == {"name", "x", "y"}
    assert payload["ticks"], "no ticks"
    for tk in payload["ticks"]:
        assert set(tk) == {"t", "trains", "waiting"}
        assert len(tk["waiting"]) == n, "waiting must be one int per station"
        assert len(tk["trains"]) == cfg.n_trains, "train count changed"
        for tr in tk["trains"]:
            assert set(tr) == {"pos", "onboard", "holding", "obs"}
            assert 0.0 <= tr["pos"] <= n - 1, f"pos out of range {tr['pos']}"
            assert isinstance(tr["holding"], bool)
            assert set(tr["obs"]) == {"headway_ahead_ratio",
                                      "headway_behind_ratio",
                                      "dwell_over_max_dwell"}
            for key, val in tr["obs"].items():
                # every observation feature is normalized to [0,1] by
                # construction. if one escapes, the interp panel would plot
                # a dot outside its own axes.
                assert 0.0 <= val <= 1.0, f"obs {key} out of [0,1]: {val}"
    ts = [tk["t"] for tk in payload["ticks"]]
    assert ts == sorted(ts), "ticks out of order"
    assert set(payload["metrics"]) == {"mean_wait", "baseline_wait",
                                       "improvement_pct"}


# ---------------------------------------------------------------------
# driver
# ---------------------------------------------------------------------

def dump_line(line: str, trained_on: str = "L", episode_ticks: int = 900,
              out_dir: Optional[str] = None,
              only_tags: Optional[list] = None) -> list:
    out_dir = out_dir or OUT_DIR
    os.makedirs(out_dir, exist_ok=True)

    cfg = build_line_config(line, episode_ticks=episode_ticks)

    # timetable baseline first, everything is measured against it.
    # needed even when re-emitting a subset, since baseline_wait is the
    # denominator of improvement_pct in every file.
    base_waits = [run_baseline(cfg, s).mean_wait() for s in METRIC_SEEDS]
    baseline_wait = float(np.mean(base_waits))

    tags = TAGS_BY_LINE[line]
    if only_tags:
        tags = [t for t in tags if t in only_tags]

    rows = []
    for tag in tags:
        if tag == "baseline":
            env = run_baseline(cfg, DUMP_SEED, record=True)
            mean_wait = baseline_wait
            cv = env.headway_cv()
        else:
            model = load_policy(trained_on, tag)
            waits, cvs = [], []
            for s in METRIC_SEEDS:
                e = run_policy(cfg, model, s)
                waits.append(e.mean_wait())
                cvs.append(e.headway_cv())
            mean_wait = float(np.mean(waits))
            cv = float(np.mean(cvs))
            env = run_policy(cfg, model, DUMP_SEED, record=True)

        payload = build_payload(line, tag, cfg, env.frames,
                                mean_wait, baseline_wait)
        validate(payload, cfg)

        path = os.path.join(out_dir, f"{line}_{tag}.json")
        with open(path, "w") as f:
            json.dump(payload, f, separators=(",", ":"))

        kb = os.path.getsize(path) / 1024.0
        imp = payload["metrics"]["improvement_pct"]
        print(f"  {line}_{tag:<8} wait={mean_wait:7.2f}  cv={cv:.3f}  "
              f"improvement={imp:+6.1f}%  {len(payload['ticks'])} ticks  "
              f"{kb:.0f}KB")
        rows.append({"line": line, "tag": tag, "mean_wait": mean_wait,
                     "cv": cv, "baseline_wait": baseline_wait,
                     "improvement_pct": imp})
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lines", nargs="*", default=LINES)
    ap.add_argument("--trained-on", default="L")
    ap.add_argument("--episode-ticks", type=int, default=900)
    ap.add_argument("--out", default=None,
                    help="override output dir (for dry runs)")
    ap.add_argument("--tags", nargs="*", default=None,
                    help="only emit these tags, for targeted re-emits")
    args = ap.parse_args()

    print(f"writing to {args.out or OUT_DIR}")
    all_rows = []
    for line in args.lines:
        print(f"\nline {line}:")
        all_rows.extend(dump_line(line, args.trained_on,
                                  args.episode_ticks, args.out,
                                  only_tags=args.tags))

    print("\n" + "=" * 70)
    print("SUMMARY (all weights trained on L only)")
    print("=" * 70)
    print(f"  {'line':<5} {'tag':<9} {'wait':>8} {'baseline':>9} "
          f"{'improve':>9} {'cv':>7}")
    for r in all_rows:
        print(f"  {r['line']:<5} {r['tag']:<9} {r['mean_wait']:8.2f} "
              f"{r['baseline_wait']:9.2f} {r['improvement_pct']:+8.1f}% "
              f"{r['cv']:7.3f}")


if __name__ == "__main__":
    main()
