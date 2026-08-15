"""
Train PPO on ONE line (the L) with parameter sharing.

Every train runs the same weights. supersuit flattens the agent dimension
into the batch dimension, so one MlpPolicy sees every train's observation as
just another row. That is what makes the policy fleet-size agnostic, and
combined with the fully normalized observation it is why the same weights
can be dropped onto the G, 7, 1 and 6 without retraining.

Checkpoints are written at 0, 25, 50 and 100 percent of training. 0 percent
is the untrained network, saved before any gradient step, which is the
honest "before" for the demo.
"""

import argparse
import os
import time

import numpy as np
import supersuit as ss
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import BaseCallback, CallbackList
from stable_baselines3.common.utils import set_random_seed

from headway_env import DWELLING, HeadwayEnv
from mta_data import build_line_config

HERE = os.path.dirname(os.path.abspath(__file__))
CKPT_DIR = os.path.join(HERE, "checkpoints")

CHECKPOINT_FRACTIONS = [0.25, 0.50, 1.00]
N_ENV_COPIES = 8

# Entropy is annealed from high to low, and it is the single thing that
# makes this problem learnable.
#
# At a fixed low entropy the policy collapses to never-hold within the first
# 100k steps and stays there for the rest of training. The trap: holding
# costs 0.5*onboard immediately and certainly, while the benefit (less
# bunching, so shorter waits) arrives later and is shared across all seven
# trains through one line-wide reward. From a random start the policy holds
# about half the time, which is genuinely terrible, so the gradient drives
# holding to zero globally before it can ever discover that SELECTIVE
# holding is what pays.
#
# Verified, not guessed: at ent_coef 0.01 the trained policy held 0 times out
# of 6300 decisions. The reward provably prefers holding (a hand written hold
# rule scores -38.1 against depart-always at -42.9), so this was an
# exploration failure rather than the reward being wrong.
#
# Starting high keeps holding alive long enough to find where it helps, then
# annealing sharpens the rule instead of leaving it random.
#
# The end value is a floor, not zero, on purpose. Annealing all the way down
# to 0.005 let the collapse creep back in over the last half of training:
# hold rate fell to 6.7 percent and spacing regressed (cv 0.066 at the 50
# percent checkpoint, 0.166 by the end). Holding onto a little entropy keeps
# the policy from drifting back toward never-hold.
ENT_COEF_START = 0.10
ENT_COEF_END = 0.02


def make_vec_env(cfg, n_copies=N_ENV_COPIES):
    env = HeadwayEnv(cfg, seed=0)
    env = ss.pettingzoo_env_to_vec_env_v1(env)
    env = ss.concat_vec_envs_v1(env, n_copies, num_cpus=1,
                                base_class="stable_baselines3")
    return env


def evaluate(model, cfg, seeds=(100, 101, 102)):
    """
    Roll out greedily on fresh seeds the policy never trained on.

    Also reports how often it holds when it actually has the choice. A hold
    rate of 0 means the policy has collapsed to depart-always, which looks
    like slow progress on wait but is really a dead run.
    """
    waits, cvs = [], []
    holds = decisions = 0
    for s in seeds:
        env = HeadwayEnv(cfg, seed=s)
        obs, _ = env.reset(seed=s)
        while env.agents:
            batch = np.stack([obs[a] for a in env.agents])
            acts, _ = model.predict(batch, deterministic=True)
            for i in range(len(env.agents)):
                if env.state[i] == DWELLING:
                    decisions += 1
                    holds += int(acts[i] == 1)
            actions = {a: int(acts[i]) for i, a in enumerate(env.agents)}
            obs, _, _, trunc, _ = env.step(actions)
            if any(trunc.values()):
                break
        m = env.summary()
        waits.append(m["mean_wait"])
        cvs.append(m["headway_cv"])
    hold_pct = 100.0 * holds / max(1, decisions)
    return float(np.mean(waits)), float(np.mean(cvs)), hold_pct


class AnnealEntropy(BaseCallback):
    """
    Linearly decays ent_coef from ENT_COEF_START to ENT_COEF_END.

    SB3 supports schedules for learning_rate and clip_range but not for
    ent_coef, so we set it directly on the model each rollout.
    """

    def __init__(self, total_steps, verbose=0):
        super().__init__(verbose)
        self.total_steps = total_steps

    def _on_step(self) -> bool:
        frac = min(1.0, self.num_timesteps / max(1, self.total_steps))
        self.model.ent_coef = (
            ENT_COEF_START + (ENT_COEF_END - ENT_COEF_START) * frac
        )
        return True


class CheckpointAtFractions(BaseCallback):
    """Saves at fixed fractions of the run and logs a real evaluation."""

    def __init__(self, total_steps, cfg, line, verbose=0):
        super().__init__(verbose)
        self.total_steps = total_steps
        self.cfg = cfg
        self.line = line
        self.pending = [(f, int(f * total_steps))
                        for f in CHECKPOINT_FRACTIONS]
        self.t0 = time.time()

    def _on_step(self) -> bool:
        while self.pending and self.num_timesteps >= self.pending[0][1]:
            frac, _ = self.pending.pop(0)
            tag = f"{int(round(frac * 100)):03d}"
            path = os.path.join(CKPT_DIR, f"{self.line}_{tag}")
            self.model.save(path)
            w, cv, hp = evaluate(self.model, self.cfg)
            el = time.time() - self.t0
            print(f"  [{tag}%] steps={self.num_timesteps:>9,}  "
                  f"mean_wait={w:7.2f}  cv={cv:.3f}  hold={hp:5.1f}%  "
                  f"({el / 60:.1f} min)", flush=True)
        return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--line", default="L")
    ap.add_argument("--steps", type=int, default=20_000_000)
    ap.add_argument("--episode-ticks", type=int, default=900)
    args = ap.parse_args()

    os.makedirs(CKPT_DIR, exist_ok=True)
    cfg = build_line_config(args.line, episode_ticks=args.episode_ticks)

    print(f"training on line {args.line}: {cfg.n_stations} stations, "
          f"{cfg.n_trains} trains, {cfg.episode_ticks} ticks/episode")
    print(f"target {args.steps:,} timesteps")

    env = make_vec_env(cfg)
    print(f"vec env: {env.num_envs} parallel agent streams "
          f"({cfg.n_trains} trains x {N_ENV_COPIES} copies)")

    # NOTE: no seed= here. SB3 forwards it to env.seed(), which supersuit's
    # ConcatVecEnv does not implement. Seed globally instead.
    set_random_seed(0)

    model = PPO(
        "MlpPolicy",
        env,
        learning_rate=3e-4,
        n_steps=1024,     # long rollouts: the payoff from holding is delayed
        batch_size=512,
        n_epochs=6,
        gamma=0.995,      # long horizon: holding pays off many ticks later
        gae_lambda=0.95,
        clip_range=0.2,
        ent_coef=ENT_COEF_START,   # annealed down by AnnealEntropy
        vf_coef=0.5,
        verbose=0,
        device="cpu",
    )

    # 0 percent: the untrained network, before any gradient step
    zero = os.path.join(CKPT_DIR, f"{args.line}_000")
    model.save(zero)
    w0, cv0, hp0 = evaluate(model, cfg)
    print(f"  [000%] steps={0:>9,}  mean_wait={w0:7.2f}  cv={cv0:.3f}  "
          f"hold={hp0:5.1f}%  (untrained)", flush=True)

    cb = CallbackList([
        AnnealEntropy(args.steps),
        CheckpointAtFractions(args.steps, cfg, args.line),
    ])
    t0 = time.time()
    model.learn(total_timesteps=args.steps, callback=cb, progress_bar=False)

    print(f"\ndone in {(time.time() - t0) / 60:.1f} min")
    print(f"checkpoints in {CKPT_DIR}")


if __name__ == "__main__":
    main()
