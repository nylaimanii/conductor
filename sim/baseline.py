"""
Fixed-headway timetable baseline.

This is what the MTA actually runs: a schedule fixed in advance. Train i is
supposed to be at a particular point on the line at a particular time. If it
is running early it waits; if it is running late it just goes, because a
timetable has no way to make up time.

The point of comparison is NOT that a timetable is stupid. It does hold
early trains, which is real regulation. The point is that the schedule is
computed once, offline, from average running times, so it cannot react when
a demand spike makes one train slow. That is precisely the situation the
learned policy is allowed to respond to.

The nominal running speed is measured from the line itself under a
depart-always policy, so the timetable is built from honest observed running
times rather than a number picked to make it lose.
"""

import numpy as np

from headway_env import HeadwayEnv


class TimetableBaseline:
    """Fixed schedule, computed once, never adapts."""

    def __init__(self, cfg, calib_seeds=(0, 1, 2)):
        self.cfg = cfg
        self.v_sched = self._measure_running_speed(calib_seeds)
        self.spacing = cfg.cycle_length / cfg.n_trains

    def _measure_running_speed(self, seeds):
        """
        Average ring progress per tick under depart-always. This is the
        realistic round trip time the timetable gets planned around,
        including typical dwell.
        """
        speeds = []
        for s in seeds:
            env = HeadwayEnv(self.cfg, seed=s)
            env.reset(seed=s)
            prev = [env._line_to_ring(env.pos[i], int(env.dir[i]))
                    for i in range(self.cfg.n_trains)]
            travelled = np.zeros(self.cfg.n_trains)
            ticks = 0
            while env.agents:
                _, _, _, trunc, _ = env.step({a: 0 for a in env.agents})
                ticks += 1
                for i in range(self.cfg.n_trains):
                    c = env._line_to_ring(env.pos[i], int(env.dir[i]))
                    travelled[i] += (c - prev[i]) % self.cfg.cycle_length
                    prev[i] = c
                if any(trunc.values()):
                    break
            speeds.append(travelled.mean() / max(1, ticks))
        return float(np.mean(speeds))

    def scheduled_ring(self, i: int, t: int) -> float:
        """Where train i is supposed to be at tick t."""
        return (self.phase[i] + self.v_sched * t) % self.cfg.cycle_length

    def reset(self, env):
        """Lock the schedule to the trains' starting positions."""
        self.phase = [env._line_to_ring(env.pos[i], int(env.dir[i]))
                      for i in range(self.cfg.n_trains)]

    def act(self, env) -> dict:
        """Hold while ahead of schedule, otherwise depart."""
        cyc = self.cfg.cycle_length
        actions = {}
        for i, a in enumerate(env.agents):
            actual = env._line_to_ring(env.pos[i], int(env.dir[i]))
            sched = self.scheduled_ring(i, env.t)
            ahead = (actual - sched) % cyc
            early = ahead < cyc / 2.0 and ahead > 0.0
            actions[a] = 1 if early else 0
        return actions


def run_baseline(cfg, seed: int, record: bool = False):
    """One episode under the timetable. Returns the env for metrics/frames."""
    ctrl = TimetableBaseline(cfg)
    env = HeadwayEnv(cfg, seed=seed, record=record)
    env.reset(seed=seed)
    ctrl.reset(env)
    while env.agents:
        obs, _, _, trunc, _ = env.step(ctrl.act(env))
        if any(trunc.values()):
            break
    return env


def run_depart_always(cfg, seed: int, record: bool = False):
    """No control at all. Useful as a floor reference."""
    env = HeadwayEnv(cfg, seed=seed, record=record)
    env.reset(seed=seed)
    while env.agents:
        _, _, _, trunc, _ = env.step({a: 0 for a in env.agents})
        if any(trunc.values()):
            break
    return env


if __name__ == "__main__":
    from mta_data import all_line_configs

    print(f"  {'line':<5} {'policy':<16} {'mean_wait':>10} {'cv':>7} "
          f"{'boarded':>16}")
    for ln, cfg in all_line_configs().items():
        for label, fn in [("depart_always", run_depart_always),
                          ("timetable", run_baseline)]:
            ms = [fn(cfg, s).summary() for s in (0, 1, 2)]
            w = np.mean([m["mean_wait"] for m in ms])
            cv = np.mean([m["headway_cv"] for m in ms])
            bo = np.mean([m["boarded"] for m in ms])
            ar = np.mean([m["arrived"] for m in ms])
            print(f"  {ln:<5} {label:<16} {w:10.2f} {cv:7.3f} "
                  f"{bo:7.0f}/{ar:<7.0f}")
        print()
