"""
TASK 1 plumbing test. This does NOT test the HEADWAY idea.

It proves exactly one thing: a stock PettingZoo ParallelEnv can go through
supersuit's vec wrappers into stable-baselines3 PPO, train for a few thousand
steps, and produce a policy we can save, reload, and step.

We use simple_spread_v3 because it matches the shape HEADWAY needs:
homogeneous agents, vector observations, Discrete actions, one shared policy
via parameter sharing.
"""

import numpy as np
import supersuit as ss
from pettingzoo.mpe import simple_spread_v3
from stable_baselines3 import PPO
from stable_baselines3.common.utils import set_random_seed

N_AGENTS = 3
TRAIN_STEPS = 4000
N_ENV_COPIES = 2


def main():
    print("=" * 60)
    print("HEADWAY task 1: pettingzoo -> supersuit -> SB3 PPO")
    print("=" * 60)

    # 1. stock parallel env
    env = simple_spread_v3.parallel_env(
        N=N_AGENTS,
        local_ratio=0.5,
        max_cycles=25,
        continuous_actions=False,
    )
    env.reset(seed=0)
    a0 = env.agents[0]
    print(f"agents            : {env.agents}")
    print(f"obs space  ({a0}) : {env.observation_space(a0)}")
    print(f"act space  ({a0}) : {env.action_space(a0)}")

    # 2. supersuit: flatten agent dim into the batch dim.
    # every agent becomes a row in one big vec env, which is what gives us
    # parameter sharing for free.
    env = ss.pettingzoo_env_to_vec_env_v1(env)
    print(f"after pz_to_vec   : num_envs={env.num_envs}  (expect {N_AGENTS})")

    env = ss.concat_vec_envs_v1(
        env,
        N_ENV_COPIES,
        num_cpus=1,
        base_class="stable_baselines3",
    )
    print(f"after concat      : num_envs={env.num_envs} "
          f"(expect {N_AGENTS * N_ENV_COPIES})")
    print(f"vec obs space     : {env.observation_space}")
    print(f"vec act space     : {env.action_space}")

    # 3. SB3 accepts it.
    # NOTE: do NOT pass seed= to PPO. SB3 forwards it to env.seed(), and
    # supersuit's ConcatVecEnv has no .seed() method, so it raises
    # AttributeError. Seed globally instead, and seed the env at reset.
    # This applies to the real HEADWAY training too.
    set_random_seed(0)
    model = PPO(
        "MlpPolicy",
        env,
        n_steps=128,
        batch_size=64,
        verbose=0,
        device="cpu",
    )
    print("\nPPO constructed. training...")

    model.learn(total_timesteps=TRAIN_STEPS, progress_bar=False)
    print(f"trained {TRAIN_STEPS} steps without error")

    # 4. save / reload round trip, we need this for the checkpoint story
    path = "/tmp/headway_smoke_ppo"
    model.save(path)
    reloaded = PPO.load(path, device="cpu")
    print("save + reload ok")

    # 5. the reloaded policy actually produces actions on fresh obs
    obs = env.reset()
    if isinstance(obs, tuple):
        obs = obs[0]
    obs = np.asarray(obs)
    actions, _ = reloaded.predict(obs, deterministic=True)
    print(f"obs batch shape   : {obs.shape}")
    print(f"actions           : {np.asarray(actions).ravel().tolist()}")

    # 6. and we can step the env with them
    step_out = env.step(np.asarray(actions))
    rewards = np.asarray(step_out[1])
    print(f"step rewards      : {np.round(rewards, 3).ravel().tolist()}")

    print("\n" + "=" * 60)
    print("TASK 1 PASS. plumbing is good, no fallback needed.")
    print("=" * 60)


if __name__ == "__main__":
    main()
