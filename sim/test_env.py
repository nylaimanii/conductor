"""
Env checks. Runs the official PettingZoo parallel API test, verifies the
observation really is 12 normalized dimensionless floats, and pushes the env
through the same supersuit -> SB3 path the real training uses.
"""

import numpy as np
import supersuit as ss
from pettingzoo.test import parallel_api_test
from stable_baselines3 import PPO
from stable_baselines3.common.utils import set_random_seed

from headway_env import HeadwayEnv, OBS_DIM
from line_config import synthetic_line


def check_api():
    env = HeadwayEnv(synthetic_line(), seed=0)
    parallel_api_test(env, num_cycles=200)
    print("pettingzoo parallel_api_test: PASS")


def check_observation_is_normalized():
    """
    The transfer result lives or dies here. Every element must stay in [0,1]
    on wildly different line sizes, and the vector must not shift when the
    only thing that changed is how big the line is.
    """
    seen = []
    for n_stations, n_trains in [(8, 3), (24, 8), (40, 12)]:
        cfg = synthetic_line(n_stations=n_stations, n_trains=n_trains)
        env = HeadwayEnv(cfg, seed=1)
        obs, _ = env.reset(seed=1)

        lo, hi = 1e9, -1e9
        for _ in range(400):
            acts = {a: np.random.randint(0, 2) for a in env.agents}
            obs, _, _, trunc, _ = env.step(acts)
            for v in obs.values():
                assert v.shape == (OBS_DIM,), f"obs dim {v.shape}"
                assert np.all(np.isfinite(v)), "non finite in obs"
                assert np.all(v >= -1e-6) and np.all(v <= 1 + 1e-6), \
                    f"obs out of [0,1]: {v}"
                lo, hi = min(lo, float(v.min())), max(hi, float(v.max()))
            if any(trunc.values()):
                break

        m = env.summary()
        seen.append((n_stations, n_trains, m))
        print(f"  {n_stations:>2} stations / {n_trains:>2} trains  "
              f"obs range [{lo:.3f}, {hi:.3f}]  "
              f"mean_wait={m['mean_wait']:>6.2f}  cv={m['headway_cv']:.3f}")

    print("observation normalization: PASS (all in [0,1], all dimensionless)")
    return seen


def check_no_line_identity_leak():
    """
    Two lines of very different size, same relative state, should produce
    observations in the same range. If a raw count leaked in, the magnitudes
    would diverge with line size and the policy would learn 'L' instead of
    'headway'.
    """
    means = []
    for n_stations in [8, 24, 40]:
        cfg = synthetic_line(n_stations=n_stations,
                             n_trains=max(3, n_stations // 4))
        env = HeadwayEnv(cfg, seed=2)
        env.reset(seed=2)
        acc = []
        for _ in range(300):
            acts = {a: 0 for a in env.agents}
            obs, _, _, trunc, _ = env.step(acts)
            acc.append(np.mean([v for v in obs.values()], axis=0))
            if any(trunc.values()):
                break
        means.append(np.mean(acc, axis=0))

    spread = np.max(np.abs(means[0] - means[2]))
    print(f"cross-line feature drift (8 vs 40 stations): max {spread:.3f}")
    # position and time features legitimately differ in distribution, so this
    # is a smell test, not a proof. a raw count leak would blow way past 1.0.
    assert spread < 1.0, "a feature scales with line size, likely a raw count"
    print("no line identity leak: PASS")


def check_pos_stays_on_the_track():
    """
    Trains must never leave the line. Regression test for a real bug: at the
    exact ring midpoint a train was handed direction +1 while already sitting
    on the last station, so it walked off the end (pos 20.5 on a 21 station
    line). G hit it because 40/6 puts a train exactly on the boundary; the L
    never did, so only the transfer lines exposed it.

    Covers both the real lines and fleet sizes chosen to land exactly on the
    turnaround.
    """
    from mta_data import all_line_configs

    cases = list(all_line_configs().items())
    for n_st, n_tr in [(21, 6), (11, 4), (9, 2), (13, 8)]:
        cases.append((f"synth{n_st}/{n_tr}",
                      synthetic_line(n_stations=n_st, n_trains=n_tr)))

    for label, cfg in cases:
        for pol in (0, 1):
            env = HeadwayEnv(cfg, seed=7)
            env.reset(seed=7)
            lo, hi = 1e9, -1e9
            while env.agents:
                _, _, _, trunc, _ = env.step({a: pol for a in env.agents})
                lo, hi = min(lo, env.pos.min()), max(hi, env.pos.max())
                assert lo >= -1e-9, f"{label}: pos {lo} below station 0"
                assert hi <= cfg.n_stations - 1 + 1e-9, \
                    f"{label}: pos {hi} past last station {cfg.n_stations - 1}"
                if any(trunc.values()):
                    break
        print(f"  {label:<12} pos stayed in [0, {cfg.n_stations - 1}]")
    print("trains stay on the track: PASS")


def check_sb3_pipeline():
    cfg = synthetic_line(n_stations=16, n_trains=6)
    env = HeadwayEnv(cfg, seed=0)
    env = ss.pettingzoo_env_to_vec_env_v1(env)
    env = ss.concat_vec_envs_v1(env, 2, num_cpus=1,
                                base_class="stable_baselines3")
    print(f"vec env: num_envs={env.num_envs} obs={env.observation_space} "
          f"act={env.action_space}")

    set_random_seed(0)
    model = PPO("MlpPolicy", env, n_steps=128, batch_size=64,
                verbose=0, device="cpu")
    model.learn(total_timesteps=3000)
    print("SB3 PPO on HeadwayEnv: PASS (3000 steps)")


def check_hold_forever_cannot_deadlock():
    """A degenerate policy must not freeze the line. max_dwell forces departure."""
    cfg = synthetic_line(n_stations=12, n_trains=4)
    env = HeadwayEnv(cfg, seed=3)
    env.reset(seed=3)
    start = env.pos.copy()
    for _ in range(300):
        env.step({a: 1 for a in env.agents})  # hold, always
    moved = np.abs(env.pos - start).sum()
    assert moved > 0.5, "trains deadlocked when every agent held"
    print(f"hold-forever deadlock guard: PASS (trains still moved {moved:.1f})")


if __name__ == "__main__":
    print("=" * 62)
    check_api()
    print("-" * 62)
    check_observation_is_normalized()
    print("-" * 62)
    check_no_line_identity_leak()
    print("-" * 62)
    check_hold_forever_cannot_deadlock()
    print("-" * 62)
    check_pos_stays_on_the_track()
    print("-" * 62)
    check_sb3_pipeline()
    print("=" * 62)
    print("ENV OK")
