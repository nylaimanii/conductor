"""
The honest numbers table.

Evaluates every controller on every line over the same unseen seeds, so the
comparison is paired: identical passenger arrivals, only the control policy
differs. (Arrival draws depend on the tick, not on what the trains do, so a
given seed produces the same passengers under every policy.)

Nothing here is tuned per line. The PPO weights were trained on the L and are
run unchanged everywhere else.
"""

import argparse

import numpy as np

from baseline import run_baseline, run_depart_always
from dump import METRIC_SEEDS, load_policy, run_policy
from headway_env import DWELLING, HeadwayEnv
from mta_data import LINES, build_line_config


def hold_rate(cfg, model, seed):
    env = HeadwayEnv(cfg, seed=seed)
    obs, _ = env.reset(seed=seed)
    holds = decisions = 0
    while env.agents:
        batch = np.stack([obs[a] for a in env.agents])
        acts, _ = model.predict(batch, deterministic=True)
        for i in range(len(env.agents)):
            if env.state[i] == DWELLING:
                decisions += 1
                holds += int(acts[i] == 1)
        obs, _, _, trunc, _ = env.step(
            {a: int(acts[i]) for i, a in enumerate(env.agents)})
        if any(trunc.values()):
            break
    return 100.0 * holds / max(1, decisions)


def agg(envs):
    return (float(np.mean([e.mean_wait() for e in envs])),
            float(np.mean([e.headway_cv() for e in envs])))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--trained-on", default="L")
    ap.add_argument("--seeds", type=int, nargs="*", default=list(METRIC_SEEDS))
    args = ap.parse_args()
    seeds = args.seeds

    m000 = load_policy(args.trained_on, "000")
    m100 = load_policy(args.trained_on, "100")

    print(f"seeds {seeds}, none seen during training")
    print(f"PPO weights trained on line {args.trained_on} only, "
          f"run unchanged everywhere\n")

    header = (f"  {'line':<4} {'controller':<20} {'mean_wait':>10} "
              f"{'cv':>7} {'vs timetable':>13} {'hold':>7}")
    print(header)
    print("  " + "-" * (len(header) - 2))

    rows = []
    for line in LINES:
        cfg = build_line_config(line)

        base_w, base_cv = agg([run_baseline(cfg, s) for s in seeds])
        da_w, da_cv = agg([run_depart_always(cfg, s) for s in seeds])
        p0_w, p0_cv = agg([run_policy(cfg, m000, s) for s in seeds])
        p1_w, p1_cv = agg([run_policy(cfg, m100, s) for s in seeds])
        h1 = hold_rate(cfg, m100, seeds[0])

        def delta(w):
            return 100.0 * (base_w - w) / base_w

        note = "TRAINED HERE" if line == args.trained_on else "zero-shot"
        for label, w, cv, h in [
            ("no control", da_w, da_cv, 0.0),
            ("timetable baseline", base_w, base_cv, float("nan")),
            ("PPO untrained (000)", p0_w, p0_cv, float("nan")),
            (f"PPO trained (100)", p1_w, p1_cv, h1),
        ]:
            hs = "     . " if np.isnan(h) else f"{h:6.1f}%"
            print(f"  {line:<4} {label:<20} {w:10.2f} {cv:7.3f} "
                  f"{delta(w):+12.1f}% {hs}")
        print(f"  {'':<4} {'^ ' + note}")
        print()

        rows.append(dict(line=line, base_w=base_w, base_cv=base_cv,
                         da_w=da_w, da_cv=da_cv, p1_w=p1_w, p1_cv=p1_cv))

    print("=" * 72)
    print("HEADLINE: spacing (headway coefficient of variation, 0 = perfect)")
    print("=" * 72)
    print(f"  {'line':<4} {'no control':>11} {'timetable':>11} "
          f"{'PPO (L only)':>13} {'vs no control':>14}")
    for r in rows:
        red = 100.0 * (r["da_cv"] - r["p1_cv"]) / max(1e-9, r["da_cv"])
        print(f"  {r['line']:<4} {r['da_cv']:11.3f} {r['base_cv']:11.3f} "
              f"{r['p1_cv']:13.3f} {red:+13.1f}%")

    print()
    print("SUPPORTING: mean passenger wait, ticks")
    print(f"  {'line':<4} {'no control':>11} {'timetable':>11} "
          f"{'PPO (L only)':>13} {'vs timetable':>14}")
    for r in rows:
        d = 100.0 * (r["base_w"] - r["p1_w"]) / r["base_w"]
        print(f"  {r['line']:<4} {r['da_w']:11.2f} {r['base_w']:11.2f} "
              f"{r['p1_w']:13.2f} {d:+13.1f}%")


if __name__ == "__main__":
    main()
