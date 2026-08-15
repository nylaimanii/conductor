"""
Sweep the hold penalty beta and map the spacing / wait tradeoff frontier.

beta is the weight on passengers held aboard a stopped train:

    reward = -(waiting) - beta*(onboard held) - 2.0*(stranded)

The spec value is 0.5, which is what the shipped 012 policy trained with.
Raising beta makes holding more expensive, so the hypothesis is: less
holding, worse cv, better wait. If some beta beats the timetable on BOTH,
that is the setting worth shipping. If none does, that is a real finding
and gets reported as one.

Everything except beta is held identical: same seed, same hyperparameters,
same 2,400,048 timestep cut, same entropy anneal against the original
20,000,000 step horizon, same env, same demand. Checkpoints go to
checkpoints_beta/ so the shipped 012 policy in checkpoints/ is never
touched.

beta=0.5 is retrained rather than reused, as a determinism check: it should
reproduce the shipped policy exactly.
"""

import json
import os
import time
from dataclasses import replace

import numpy as np
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import BaseCallback, CallbackList
from stable_baselines3.common.utils import set_random_seed

from baseline import run_baseline
from dump import METRIC_SEEDS, run_policy
from headway_env import DWELLING, HeadwayEnv, TICK_SECONDS
from mta_data import LINES, build_line_config
from train import (ANNEAL_HORIZON, AnnealEntropy, ENT_COEF_START,
                   N_ENV_COPIES, make_vec_env)

HERE = os.path.dirname(os.path.abspath(__file__))
CKPT_DIR = os.path.join(HERE, "checkpoints_beta")
OUT = os.path.join(HERE, "beta_sweep.json")

BETAS = [0.5, 1.0, 2.0, 4.0]
STEPS = 2_400_048          # the 012 cut, exactly
MIN = TICK_SECONDS / 60.0


class StopAt(BaseCallback):
    def __init__(self, steps):
        super().__init__()
        self.steps = steps

    def _on_step(self) -> bool:
        return self.num_timesteps < self.steps


def train_one(beta: float):
    cfg = replace(build_line_config("L"), hold_penalty=beta)
    env = make_vec_env(cfg)
    set_random_seed(0)
    model = PPO("MlpPolicy", env, learning_rate=3e-4, n_steps=1024,
                batch_size=512, n_epochs=6, gamma=0.995, gae_lambda=0.95,
                clip_range=0.2, ent_coef=ENT_COEF_START, vf_coef=0.5,
                verbose=0, device="cpu")
    cb = CallbackList([AnnealEntropy(ANNEAL_HORIZON), StopAt(STEPS)])
    model.learn(total_timesteps=STEPS + 4096, callback=cb,
                progress_bar=False)
    os.makedirs(CKPT_DIR, exist_ok=True)
    path = os.path.join(CKPT_DIR, f"L_beta{beta:g}")
    model.save(path)
    return model


def hold_rate(cfg, model, seed):
    env = HeadwayEnv(cfg, seed=seed)
    obs, _ = env.reset(seed=seed)
    h = d = 0
    while env.agents:
        b = np.stack([obs[a] for a in env.agents])
        acts, _ = model.predict(b, deterministic=True)
        for i in range(len(env.agents)):
            if env.state[i] == DWELLING:
                d += 1
                h += int(acts[i] == 1)
        obs, _, _, tr, _ = env.step(
            {a: int(acts[i]) for i, a in enumerate(env.agents)})
        if any(tr.values()):
            break
    return 100.0 * h / max(1, d)


def evaluate_all_lines(model):
    """
    Evaluate on the UNMODIFIED lines. beta is a training-time reward weight,
    so the evaluation environment must stay at the spec value or the
    policies would be scored on different problems.
    """
    out = {}
    for ln in LINES:
        cfg = build_line_config(ln)
        cvs, ws = [], []
        for s in METRIC_SEEDS:
            e = run_policy(cfg, model, s)
            cvs.append(e.headway_cv())
            ws.append(e.mean_wait())
        bw = np.mean([run_baseline(cfg, s).mean_wait() for s in METRIC_SEEDS])
        bcv = np.mean([run_baseline(cfg, s).headway_cv()
                       for s in METRIC_SEEDS])
        out[ln] = {
            "cv": float(np.mean(cvs)),
            "wait_ticks": float(np.mean(ws)),
            "wait_min": float(np.mean(ws)) * MIN,
            "tt_cv": float(bcv),
            "tt_wait_ticks": float(bw),
            "tt_wait_min": float(bw) * MIN,
            "cv_vs_tt_pct": float(100.0 * (bcv - np.mean(cvs)) / bcv),
            "wait_vs_tt_pct": float(100.0 * (bw - np.mean(ws)) / bw),
            "hold_pct": hold_rate(cfg, model, METRIC_SEEDS[0]),
        }
    return out


def main():
    results = {"betas": {}, "steps": STEPS, "tick_seconds": TICK_SECONDS}
    for beta in BETAS:
        t0 = time.time()
        print(f"\nbeta={beta:g}  training {STEPS:,} steps ...", flush=True)
        model = train_one(beta)
        res = evaluate_all_lines(model)
        results["betas"][f"{beta:g}"] = res
        print(f"  ({time.time()-t0:.0f}s)  "
              f"L: cv {res['L']['cv']:.3f} wait {res['L']['wait_min']:.2f}min "
              f"hold {res['L']['hold_pct']:.1f}%", flush=True)
        for ln in LINES:
            r = res[ln]
            print(f"    {ln:<2} cv {r['cv']:.3f} ({r['cv_vs_tt_pct']:+5.1f}% "
                  f"vs tt)   wait {r['wait_min']:5.2f} min "
                  f"({r['wait_vs_tt_pct']:+5.1f}% vs tt)", flush=True)

    with open(OUT, "w") as f:
        json.dump(results, f, indent=1)
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
