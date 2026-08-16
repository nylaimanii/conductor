"""
Sweep the per-train-in-service cost and find the knee.

For each delta the policy is trained fresh on the L for 2,400,048 timesteps,
same seed and hyperparameters as the shipped policy, then evaluated on unseen
seeds. Reported per delta: the fleet size it converges to, mean platform
wait, mean total journey time, and cv, against the timetable baseline running
the shipped fleet of 7.

delta=0 is the degenerate control. Trains are free, so a working setup should
run the fleet flat out; if it does not, the dispatch lever is not being
learned and nothing below it means anything.

Journey time is reported over every arrival, not just completed trips, so
pulling trains out of service cannot flatter the number by removing riders
from it. Riders aboard a withdrawn train are returned to the platform.
"""

import json
import os
import time

import numpy as np
import supersuit as ss
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import CallbackList
from stable_baselines3.common.utils import set_random_seed

from baseline import run_baseline
from dump import METRIC_SEEDS
from fleet_env import FleetHeadwayEnv
from headway_env import TICK_SECONDS
from mta_data import build_line_config
from sweep_beta import StopAt
from train import ANNEAL_HORIZON, AnnealEntropy, ENT_COEF_START, N_ENV_COPIES

HERE = os.path.dirname(os.path.abspath(__file__))
CKPT_DIR = os.path.join(HERE, "checkpoints_fleet")
OUT = os.path.join(HERE, "fleet_experiment.json")

LINE = "L"
N_MAX = 14          # twice the shipped fleet, so the cap is not the answer
N_START = 7         # start at the shipped fleet size, neutral
STEPS = 2_400_048
DELTAS = [0.0, 1.0, 2.0, 5.0, 10.0, 20.0]
MIN = TICK_SECONDS / 60.0


def make_env(delta, seed=0, record=False):
    return FleetHeadwayEnv(build_line_config(LINE), n_max=N_MAX,
                           n_start=N_START, train_cost=delta,
                           seed=seed, record=record)


def make_vec(delta):
    env = make_env(delta)
    env = ss.pettingzoo_env_to_vec_env_v1(env)
    return ss.concat_vec_envs_v1(env, N_ENV_COPIES, num_cpus=1,
                                 base_class="stable_baselines3")


def train_one(delta):
    env = make_vec(delta)
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
    model.save(os.path.join(CKPT_DIR, f"L_fleet_d{delta:g}"))
    return model


def evaluate(model, delta):
    fleets, waits, journeys, cvs, unserved = [], [], [], [], []
    for s in METRIC_SEEDS:
        env = make_env(delta, seed=s, record=True)
        obs, _ = env.reset(seed=s)
        while env.agents:
            b = np.stack([obs[a] for a in env.agents])
            acts, _ = model.predict(b, deterministic=True)
            obs, _, _, tr, _ = env.step(
                {a: int(acts[i]) for i, a in enumerate(env.agents)})
            if any(tr.values()):
                break
        fleets.append(env.mean_fleet())
        waits.append(env.mean_wait())
        journeys.append((env.total_wait_ticks + env.total_invehicle_ticks)
                        / env.n_arrived)
        cvs.append(env.headway_cv())
        unserved.append(env.unserved_pct())
    return {
        "mean_fleet": float(np.mean(fleets)),
        "wait_ticks": float(np.mean(waits)),
        "journey_all_ticks": float(np.mean(journeys)),
        "cv": float(np.mean(cvs)),
        "unserved_pct": float(np.mean(unserved)),
    }


def main():
    cfg = build_line_config(LINE)
    tt = [run_baseline(cfg, s) for s in METRIC_SEEDS]
    base = {
        "mean_fleet": float(cfg.n_trains),
        "wait_ticks": float(np.mean([e.mean_wait() for e in tt])),
        "journey_all_ticks": float(np.mean(
            [(e.total_wait_ticks + e.total_invehicle_ticks) / e.n_arrived
             for e in tt])),
        "cv": float(np.mean([e.headway_cv() for e in tt])),
        "unserved_pct": float(np.mean([e.unserved_pct() for e in tt])),
    }
    print(f"timetable baseline, fleet {base['mean_fleet']:.0f}: "
          f"wait {base['wait_ticks']*MIN:.2f} min  "
          f"journey {base['journey_all_ticks']*MIN:.2f} min  "
          f"cv {base['cv']:.3f}", flush=True)

    results = {"line": LINE, "n_max": N_MAX, "n_start": N_START,
               "steps": STEPS, "tick_seconds": TICK_SECONDS,
               "timetable": base, "deltas": {}}

    for d in DELTAS:
        t0 = time.time()
        print(f"\ndelta={d:g} training ...", flush=True)
        model = train_one(d)
        r = evaluate(model, d)
        results["deltas"][f"{d:g}"] = r
        print(f"  ({time.time()-t0:.0f}s) fleet {r['mean_fleet']:5.2f}  "
              f"wait {r['wait_ticks']*MIN:5.2f} min  "
              f"journey {r['journey_all_ticks']*MIN:6.2f} min  "
              f"cv {r['cv']:.3f}  unserved {r['unserved_pct']:.1f}%",
              flush=True)

    with open(OUT, "w") as f:
        json.dump(results, f, indent=1)
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
