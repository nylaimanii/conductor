"""
Fleet-size control: the policy decides how many trains to run.

supersuit needs a constant agent set, so trains are never created or
destroyed. The fleet is N_MAX agents and each one is either IN SERVICE or
parked IN YARD. A yard train can be injected at a terminal; an in-service
train can be pulled out at a terminal. That gives the policy a real dispatch
lever without breaking the vec wrapper.

Actions, Discrete(3), meaning depends on where the train is:

    in yard            1 = inject into service, else stay parked
    in service, at a   0 = depart   1 = hold   2 = pull out to yard
      terminal
    in service, mid    0 = depart   1 = hold   2 = treated as depart
      line

Reward gains a per-train-in-service cost delta, charged every tick:

    -(waiting) - beta*held - gamma*riding - 2*stranded - delta*in_service

Without delta the answer is trivially "run every train you have", so delta
is the whole point of the experiment and gets swept.

Observation is 14 floats here, not the shipped 12: the policy cannot make a
dispatch decision without knowing whether it is currently in service and how
big the fleet already is. Both additions are normalized and dimensionless
like the rest. This is an experimental variant and is NOT the shipped
observation spec.

Headway is computed over in-service trains only, and the mean headway the
ratios are divided by tracks the current fleet size, so a headway ratio of
1.0 still means evenly spaced whatever the fleet is doing.
"""

import functools
from typing import Optional

import numpy as np
from gymnasium.spaces import Box, Discrete

from headway_env import DWELLING, MOVING, HeadwayEnv, OBS_DIM
from line_config import LineConfig

DEPART = 0
HOLD = 1
DISPATCH = 2      # pull out of service, at a terminal
INJECT = 1        # for a yard train, same index as HOLD

FLEET_OBS_DIM = OBS_DIM + 2
MIN_IN_SERVICE = 2


class FleetHeadwayEnv(HeadwayEnv):
    """HeadwayEnv where the policy also chooses how many trains run."""

    metadata = {"render_modes": [], "name": "headway_fleet_v1"}

    def __init__(self, config: LineConfig, n_max: int, n_start: int,
                 train_cost: float = 0.0, seed: Optional[int] = None,
                 record: bool = False):
        self.n_max = n_max
        self.n_start = n_start
        self.train_cost = train_cost
        cfg = config
        if cfg.n_trains != n_max:
            from dataclasses import replace
            cfg = replace(config, n_trains=n_max)
        super().__init__(cfg, seed=seed, record=record)

    @functools.lru_cache(maxsize=None)
    def observation_space(self, agent):
        return Box(low=0.0, high=1.0, shape=(FLEET_OBS_DIM,),
                   dtype=np.float32)

    @functools.lru_cache(maxsize=None)
    def action_space(self, agent):
        return Discrete(3)

    # ------------------------------------------------------------------

    def _reset_state(self):
        super()._reset_state()
        cfg = self.cfg
        self.in_service = np.zeros(cfg.n_trains, dtype=bool)

        # start with n_start trains evenly spaced, the rest parked
        spacing = cfg.cycle_length / max(1, self.n_start)
        for i in range(cfg.n_trains):
            if i < self.n_start:
                p, d = self._ring_to_line(i * spacing)
                self.pos[i] = p
                self.dir[i] = d
                self.state[i] = MOVING
                self.in_service[i] = True
            else:
                self.pos[i] = 0.0
                self.dir[i] = 1
                self.state[i] = MOVING
                self.in_service[i] = False

        self.fleet_log = []
        self.n_injections = 0
        self.n_pullouts = 0

    # ------------------------------------------------------------------

    @property
    def n_in_service(self) -> int:
        return int(self.in_service.sum())

    def _mean_headway_now(self) -> float:
        return self.cfg.cycle_length / max(1, self.n_in_service)

    def _headways(self, i: int):
        """Gaps to the nearest in-service train ahead and behind."""
        if not self.in_service[i]:
            return 1.0, 1.0
        cfg = self.cfg
        cyc = cfg.cycle_length
        c_i = self._line_to_ring(self.pos[i], int(self.dir[i]))
        ahead = behind = cyc
        for j in range(cfg.n_trains):
            if j == i or not self.in_service[j]:
                continue
            c_j = self._line_to_ring(self.pos[j], int(self.dir[j]))
            fwd = (c_j - c_i) % cyc
            bwd = (c_i - c_j) % cyc
            if 0 < fwd < ahead:
                ahead = fwd
            if 0 < bwd < behind:
                behind = bwd
        mean = self._mean_headway_now()
        return ahead / mean, behind / mean

    def headway_cv(self) -> float:
        cfg = self.cfg
        idx = [i for i in range(cfg.n_trains) if self.in_service[i]]
        if len(idx) < 2:
            return 0.0
        cs = sorted(self._line_to_ring(self.pos[i], int(self.dir[i]))
                    for i in idx)
        gaps = np.array([(cs[(k + 1) % len(cs)] - cs[k]) % cfg.cycle_length
                         for k in range(len(cs))], dtype=np.float64)
        if gaps.mean() <= 0:
            return 0.0
        return float(gaps.std() / gaps.mean())

    def _observe(self, i: int) -> np.ndarray:
        base = super()._observe(i)
        extra = np.array([
            1.0 if self.in_service[i] else 0.0,
            self.n_in_service / float(self.n_max),
        ], dtype=np.float32)
        return np.clip(np.concatenate([base, extra]), 0.0, 1.0)

    # ------------------------------------------------------------------

    def _advance_train(self, i: int, action: int):
        cfg = self.cfg

        if not self.in_service[i]:
            # parked in the yard at terminal 0
            if action == INJECT and self.n_in_service < self.n_max:
                self.in_service[i] = True
                self.pos[i] = 0.0
                self.dir[i] = 1
                self.state[i] = DWELLING
                self.dwell[i] = 0
                self.n_injections += 1
            self.held[i] = False
            return

        at_terminal = (self.state[i] == DWELLING
                       and int(round(self.pos[i])) in (0, cfg.n_stations - 1))
        if (action == DISPATCH and at_terminal
                and self.n_in_service > MIN_IN_SERVICE):
            # pull out of service. anyone aboard is put back on the platform
            # rather than vanishing, so withdrawing a train is not a way to
            # delete passengers.
            station = int(round(self.pos[i]))
            for dest in range(cfg.n_stations):
                k = int(self.onboard[i, dest])
                if k:
                    for _ in range(k):
                        self.queues[station].append([dest, 0])
                    self.onboard[i, dest] = 0
            self.in_service[i] = False
            self.pos[i] = 0.0
            self.state[i] = MOVING
            self.held[i] = False
            self.n_pullouts += 1
            return

        if action == DISPATCH:
            action = DEPART
        super()._advance_train(i, action)

    # ------------------------------------------------------------------

    def _reward(self) -> float:
        waiting = sum(len(q) for q in self.queues)
        held_onboard = (float(self.onboard[self.held].sum())
                        if self.held.any() else 0.0)
        gamma = self.cfg.in_vehicle_penalty
        riding = float(self.onboard.sum()) if gamma else 0.0
        raw = (-(waiting)
               - self.cfg.hold_penalty * held_onboard
               - gamma * riding
               - 2.0 * self.tick_stranded
               - self.train_cost * self.n_in_service)
        return float(raw / (self.cfg.n_stations * self.cfg.capacity))

    def step(self, actions):
        out = super().step(actions)
        self.fleet_log.append(self.n_in_service)
        return out

    def mean_fleet(self) -> float:
        return float(np.mean(self.fleet_log)) if self.fleet_log else 0.0

    def summary(self) -> dict:
        s = super().summary()
        s.update({
            "mean_fleet": round(self.mean_fleet(), 2),
            "final_fleet": self.n_in_service,
            "injections": self.n_injections,
            "pullouts": self.n_pullouts,
            "mean_journey": round(self.mean_journey(), 3),
            "unserved_pct": round(self.unserved_pct(), 2),
        })
        return s
