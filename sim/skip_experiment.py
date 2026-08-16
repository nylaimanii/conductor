"""
Can the policy make trips faster?

Two changes from the shipped setup, both needed:
  1. a third action, skip the next station, which is the first action in
     this project that can actually shorten a trip
  2. gamma, an in-vehicle time term in the reward, which is the first thing
     that measures whether it did

gamma=0.0 is run as a control: skip is available but nothing rewards speed.
If the policy ignores skip at gamma=0 and uses it as gamma rises, the reward
term is doing the work rather than the action alone.

Trained on the L only, 2,400,048 timesteps, same seed and hyperparameters as
the shipped policy. Evaluated on all five lines against the timetable and
against shipped 012, all inside the same skip-capable env so the dynamics
are identical and only the controller differs.

THE METRIC THAT MATTERS is total journey time, platform wait plus in-vehicle
time. Reported two ways:

  journey_all      (wait + in-vehicle) over EVERY arrival. Riders who never
                   board contribute their wait and no ride. Ungameable.
  journey_boarded  over completed trips only. Flatters any policy that
                   strands people, so it is only readable next to unserved.

Skipping strands people by design, so unserved_pct is reported everywhere
and any journey improvement has to be read against it.
"""

import json
import os
import time
from dataclasses import replace

import numpy as np
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import CallbackList
from stable_baselines3.common.utils import set_random_seed
import supersuit as ss

from baseline import TimetableBaseline
from dump import METRIC_SEEDS, load_policy
from headway_env import TICK_SECONDS
from mta_data import LINES, build_line_config
from skip_env import SKIP, SkipHeadwayEnv
from sweep_beta import StopAt
from train import ANNEAL_HORIZON, AnnealEntropy, ENT_COEF_START, N_ENV_COPIES

HERE = os.path.dirname(os.path.abspath(__file__))
CKPT_DIR = os.path.join(HERE, "checkpoints_skip")
OUT = os.path.join(HERE, "skip_experiment.json")

GAMMAS = [0.0, 0.25, 0.5, 1.0]
STEPS = 2_400_048
MIN = TICK_SECONDS / 60.0


def make_vec(cfg):
    env = SkipHeadwayEnv(cfg, seed=0)
    env = ss.pettingzoo_env_to_vec_env_v1(env)
    return ss.concat_vec_envs_v1(env, N_ENV_COPIES, num_cpus=1,
                                 base_class="stable_baselines3")


def train_one(gamma: float):
    cfg = replace(build_line_config("L"), in_vehicle_penalty=gamma)
    env = make_vec(cfg)
    set_random_seed(0)
    model = PPO("MlpPolicy", env, learning_rate=3e-4, n_steps=1024,
                batch_size=512, n_epochs=6, gamma=0.995, gae_lambda=0.95,
                clip_range=0.2, ent_coef=ENT_COEF_START, vf_coef=0.5,
                verbose=0, device="cpu")
    model.learn(total_timesteps=STEPS + 4096,
                callback=CallbackList([AnnealEntropy(ANNEAL_HORIZON),
                                       StopAt(STEPS)]),
                progress_bar=False)
    os.makedirs(CKPT_DIR, exist_ok=True)
    model.save(os.path.join(CKPT_DIR, f"L_skip_g{gamma:g}"))
    return model


# ------------------------------------------------------------------
# rollouts, all inside the skip-capable env
# ------------------------------------------------------------------

def roll_policy(cfg, model, seed):
    env = SkipHeadwayEnv(cfg, seed=seed)
    obs, _ = env.reset(seed=seed)
    skips = decisions = 0
    while env.agents:
        b = np.stack([obs[a] for a in env.agents])
        acts, _ = model.predict(b, deterministic=True)
        acts = np.asarray(acts).ravel()
        skips += int((acts == SKIP).sum())
        decisions += len(acts)
        obs, _, _, tr, _ = env.step(
            {a: int(acts[i]) for i, a in enumerate(env.agents)})
        if any(tr.values()):
            break
    return env, (100.0 * skips / max(1, decisions))


def roll_timetable(cfg, seed):
    ctrl = TimetableBaseline(cfg)
    env = SkipHeadwayEnv(cfg, seed=seed)
    env.reset(seed=seed)
    ctrl.reset(env)
    while env.agents:
        _, _, _, tr, _ = env.step(ctrl.act(env))
        if any(tr.values()):
            break
    return env, 0.0


def score(roller, cfg):
    envs, skip_rates = [], []
    for s in METRIC_SEEDS:
        e, sk = roller(cfg, s)
        envs.append(e)
        skip_rates.append(sk)
    j_all = [(e.total_wait_ticks + e.total_invehicle_ticks) / e.n_arrived
             for e in envs]
    return {
        "cv": float(np.mean([e.headway_cv() for e in envs])),
        "wait_ticks": float(np.mean([e.mean_wait() for e in envs])),
        "invehicle_ticks": float(np.mean([e.mean_invehicle() for e in envs])),
        "journey_boarded_ticks": float(np.mean([e.mean_journey()
                                                for e in envs])),
        "journey_all_ticks": float(np.mean(j_all)),
        "unserved_pct": float(np.mean([e.unserved_pct() for e in envs])),
        "skip_rate_pct": float(np.mean(skip_rates)),
        "carried_past": float(np.mean([getattr(e, "n_skipped_past", 0)
                                       for e in envs])),
    }


def main():
    m012 = load_policy("L", "012")
    results = {"steps": STEPS, "tick_seconds": TICK_SECONDS, "gammas": GAMMAS,
               "lines": {}}

    controllers = {
        "timetable": lambda c, s: roll_timetable(c, s),
        "012_shipped": lambda c, s: roll_policy(c, m012, s),
    }

    for g in GAMMAS:
        t0 = time.time()
        print(f"\ntraining skip policy, gamma={g:g} ...", flush=True)
        model = train_one(g)
        controllers[f"skip_g{g:g}"] = (
            lambda c, s, m=model: roll_policy(c, m, s))
        print(f"  trained in {time.time()-t0:.0f}s", flush=True)

    for ln in LINES:
        cfg = build_line_config(ln)
        results["lines"][ln] = {k: score(f, cfg)
                                for k, f in controllers.items()}
        r = results["lines"][ln]
        print(f"\n  {ln}:", flush=True)
        for k, v in r.items():
            print(f"    {k:<14} cv {v['cv']:.3f}  wait {v['wait_ticks']*MIN:5.2f}"
                  f"  ride {v['invehicle_ticks']*MIN:6.2f}"
                  f"  journey_all {v['journey_all_ticks']*MIN:6.2f}"
                  f"  unserved {v['unserved_pct']:5.1f}%"
                  f"  skip {v['skip_rate_pct']:5.1f}%", flush=True)

    with open(OUT, "w") as f:
        json.dump(results, f, indent=1)
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
