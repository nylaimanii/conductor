"""
Skip-stop variant: Discrete(3) instead of Discrete(2).

    0 depart
    1 hold one tick
    2 depart AND run through the next station without stopping

This exists because the shipped 012 policy has no action that saves anyone
time. Holding only ever adds delay; the best it can do is redistribute it.
Skipping is the first action in this project that can actually make a trip
shorter, and the in-vehicle reward term is the first thing that measures
whether it did.

Written as a subclass so HeadwayEnv is untouched. With in_vehicle_penalty
left at its 0.0 default and only actions 0 and 1 ever emitted, this env is
bit-identical to the base env, which is what lets the shipped 2-action
policy and the timetable be scored in here against the same dynamics.

Skipping is not free:
  - riders waiting at the skipped station do not board, and are counted as
    stranded, which the existing -2.0 stranded term charges for
  - riders already aboard who wanted that station stay aboard and ride past
    it. On a line that reverses at the ends that means a long detour, paid
    for in in-vehicle time
  - terminals can never be skipped, because a train has to stop to reverse
"""

import functools
from typing import Optional

import numpy as np
from gymnasium.spaces import Discrete

from headway_env import DWELLING, MOVING, HeadwayEnv
from line_config import LineConfig

DEPART = 0
HOLD = 1
SKIP = 2

N_ACTIONS = 3


class SkipHeadwayEnv(HeadwayEnv):
    """HeadwayEnv plus a skip action and in-vehicle time in the reward."""

    metadata = {"render_modes": [], "name": "headway_skip_v1"}

    def __init__(self, config: LineConfig, seed: Optional[int] = None,
                 record: bool = False):
        super().__init__(config, seed=seed, record=record)

    @functools.lru_cache(maxsize=None)
    def action_space(self, agent):
        return Discrete(N_ACTIONS)

    def _reset_state(self):
        super()._reset_state()
        # skip_next[i] is armed when train i chooses SKIP, and consumed the
        # next time it reaches a station.
        self.skip_next = np.zeros(self.cfg.n_trains, dtype=bool)
        self.n_skips = 0
        self.n_skipped_past = 0     # riders carried past their own stop

    # ------------------------------------------------------------------

    def _skip_strand_count(self, i: int, station: int) -> int:
        """Riders left on the platform because this train ran through."""
        direction = int(self.dir[i])
        return sum(1 for d, _ in self.queues[station]
                   if self._eligible(d, station, direction))

    def _advance_train(self, i: int, action: int):
        cfg = self.cfg

        if self.state[i] == DWELLING:
            station = int(round(self.pos[i]))
            self.dwell[i] += 1

            service_pending = self._serve_tick(i, station)
            forced_out = self.dwell[i] >= cfg.max_dwell

            if service_pending and not forced_out:
                self.held[i] = False
                return
            if self.dwell[i] < cfg.min_dwell:
                self.held[i] = False
                return

            if action == HOLD and not forced_out:
                self.held[i] = True
                return

            # SKIP departs like DEPART but arms the run-through
            if action == SKIP:
                self.skip_next[i] = True

            left_behind = self._count_stranded(i, station)
            self.n_stranded_events += left_behind
            self.tick_stranded += left_behind
            self.state[i] = MOVING
            self.dwell[i] = 0
            self.held[i] = False
            return

        # MOVING
        if self.dir[i] > 0 and self.pos[i] >= cfg.n_stations - 1:
            self.dir[i] = -1
        elif self.dir[i] < 0 and self.pos[i] <= 0:
            self.dir[i] = 1

        prev = self.pos[i]
        nxt = prev + cfg.speed * self.dir[i]

        if self.dir[i] > 0:
            boundary = np.floor(prev) + 1.0
            arrived = nxt >= boundary - 1e-9
        else:
            boundary = np.ceil(prev) - 1.0
            arrived = nxt <= boundary + 1e-9

        if arrived:
            station = int(round(boundary))
            station = max(0, min(cfg.n_stations - 1, station))
            self.pos[i] = float(station)

            if station == 0:
                self.dir[i] = 1
            elif station == cfg.n_stations - 1:
                self.dir[i] = -1

            terminal = station in (0, cfg.n_stations - 1)
            if self.skip_next[i] and not terminal:
                # run through: no dwell, nobody boards, nobody alights
                stranded = self._skip_strand_count(i, station)
                self.n_stranded_events += stranded
                self.tick_stranded += stranded
                self.n_skipped_past += int(self.onboard[i, station])
                self.n_skips += 1
                self.skip_next[i] = False
                self.state[i] = MOVING
            else:
                # terminals always stop, a train has to reverse there
                self.skip_next[i] = False
                self.state[i] = DWELLING
                self.dwell[i] = 0
        else:
            self.pos[i] = nxt

    def summary(self) -> dict:
        s = super().summary()
        s.update({
            "skips": int(self.n_skips),
            "carried_past_stop": int(self.n_skipped_past),
            "mean_invehicle": round(self.mean_invehicle(), 3),
            "mean_journey": round(self.mean_journey(), 3),
            "unserved_pct": round(self.unserved_pct(), 2),
        })
        return s
