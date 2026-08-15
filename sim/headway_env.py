"""
HEADWAY: multi-agent subway headway control.

Each train is an agent with one binary decision at a platform: depart, or hold
one more tick. All trains share one policy via parameter sharing, so the same
weights run every train on every line.

THE CENTRAL CONSTRAINT
----------------------
The observation is 12 floats, all normalized and dimensionless. No raw counts,
no absolute positions, no line identifier. A policy that never sees "24
stations" or "37 people waiting" cannot overfit to the L, which is the entire
reason the same weights transfer to G, 7, 1, and 6 untouched.

If you add a feature here, it must be a ratio. If it has units, it does not
belong in the observation vector.
"""

import functools
from typing import Dict, List, Optional

import numpy as np
from gymnasium.spaces import Box, Discrete
from pettingzoo.utils.env import ParallelEnv

from line_config import LineConfig

# seconds of real time per sim tick, kept in step with mta_data.TICK_SECONDS
TICK_SECONDS = 10.0

OBS_DIM = 12

# Indices into the observation vector. Named so the trajectory dumper can
# export exactly the values the policy reads, rather than a reconstruction
# that might drift from it.
OBS_HEADWAY_AHEAD = 2
OBS_HEADWAY_BEHIND = 3
OBS_DWELL = 5

# actions
DEPART = 0
HOLD = 1

# train states
MOVING = 0
DWELLING = 1

# how many stations ahead the policy can see waiting counts for.
# fixed at 3 by the observation spec.
LOOKAHEAD = 3

# stations either side counted in the local crowding index.
CROWD_WINDOW = 2

# headway ratios are clipped here before being squashed into [0,1].
# 1.0 means perfectly even spacing, so the useful signal sits near the middle.
MAX_HEADWAY_RATIO = 3.0


class HeadwayEnv(ParallelEnv):
    """
    One subway line. One agent per train. Constant agent set for the whole
    episode, which supersuit's vec conversion requires: trains never die,
    they just keep looping.
    """

    metadata = {"render_modes": [], "name": "headway_v1"}

    def __init__(self, config: LineConfig, seed: Optional[int] = None,
                 record: bool = False):
        self.cfg = config
        self.record = record

        # supersuit's MarkovVectorEnv reads this off the unwrapped env at
        # construction, so it has to exist even though we never render.
        self.render_mode = None

        self.possible_agents = [f"train_{i}" for i in range(config.n_trains)]
        # agent i is always index i in every array we expose. the trajectory
        # dumper relies on this: the web side animates train i across ticks
        # by array position, so ordering must never change.
        self.agents = list(self.possible_agents)

        self._np_random = np.random.default_rng(seed)
        self._reset_state()

    # ------------------------------------------------------------------
    # spaces
    # ------------------------------------------------------------------

    @functools.lru_cache(maxsize=None)
    def observation_space(self, agent):
        return Box(low=0.0, high=1.0, shape=(OBS_DIM,), dtype=np.float32)

    @functools.lru_cache(maxsize=None)
    def action_space(self, agent):
        return Discrete(2)

    # ------------------------------------------------------------------
    # state
    # ------------------------------------------------------------------

    def _reset_state(self):
        cfg = self.cfg
        n = cfg.n_stations

        self.t = 0

        # trains start evenly spaced around the ring. a fixed timetable that
        # never reacts stays roughly like this; bunching is what happens when
        # demand shocks it and nothing corrects.
        self.pos = np.zeros(cfg.n_trains, dtype=np.float64)
        self.dir = np.ones(cfg.n_trains, dtype=np.int64)
        self.state = np.full(cfg.n_trains, DWELLING, dtype=np.int64)
        self.dwell = np.zeros(cfg.n_trains, dtype=np.int64)

        spacing = cfg.cycle_length / cfg.n_trains
        for i in range(cfg.n_trains):
            c = i * spacing
            p, d = self._ring_to_line(c)
            self.pos[i] = p
            self.dir[i] = d
            self.state[i] = MOVING

        # onboard[i][s] = passengers on train i bound for station s.
        # keeping destinations lets us alight properly instead of faking it.
        self.onboard = np.zeros((cfg.n_trains, n), dtype=np.int64)

        # per station queue of [destination, wait_ticks]
        self.queues: List[List[List[int]]] = [[] for _ in range(n)]

        # whoever chose HOLD this tick, for the reward term
        self.held = np.zeros(cfg.n_trains, dtype=bool)

        # metrics. total_wait_ticks accumulates one per waiting passenger per
        # tick, so it counts passengers who never board too. that makes
        # mean_wait impossible to game by stranding people.
        self.total_wait_ticks = 0
        self.n_arrived = 0
        self.n_boarded = 0

        # every individual passenger's wait at the moment they board.
        # the mean hides the thing bunching actually does to people: a few
        # riders eating enormous gaps. this is what the tail stats read.
        self.boarded_waits: List[int] = []
        self.n_stranded_events = 0
        self.tick_stranded = 0

        self.frames: List[dict] = []

        # raw gap-ahead ratios per train per tick, recorded alongside frames.
        # kept unclipped, unlike the observation feature which saturates at
        # 3x, because the whole point is to count how often a big gap opens.
        self.gap_log: List[List[float]] = []

    # ------------------------------------------------------------------
    # ring geometry
    #
    # trains loop at the ends, so the line unfolds into a ring of
    # circumference 2*(N-1): forward along the line, then back. on a ring the
    # gap between consecutive trains is unambiguous, which is what makes
    # "headway" a well defined thing to control.
    # ------------------------------------------------------------------

    def _line_to_ring(self, pos: float, direction: int) -> float:
        if direction > 0:
            return float(pos)
        return self.cfg.cycle_length - float(pos)

    def _ring_to_line(self, c: float):
        cyc = self.cfg.cycle_length
        c = c % cyc
        half = cyc / 2.0
        # strict <, not <=. at exactly the halfway point the train is AT the
        # far end of the line, so it is already turning back. returning +1
        # there sends it walking off the end of the track: G puts a train
        # exactly on the last station because 40/6 lands on the boundary.
        if c < half:
            return c, 1
        return cyc - c, -1

    # ------------------------------------------------------------------
    # demand
    # ------------------------------------------------------------------

    def _demand_multiplier(self, t: int) -> float:
        """
        One rush hour. Ramps up, peaks in the middle, ramps down. This is the
        shock a fixed timetable cannot react to.
        """
        u = t / max(1, self.cfg.episode_ticks)
        peak = np.exp(-((u - 0.5) ** 2) / 0.045)
        return 1.0 + (self.cfg.peak_multiplier - 1.0) * float(peak)

    def _spawn_passengers(self):
        cfg = self.cfg
        n = cfg.n_stations
        mult = self._demand_multiplier(self.t)

        for s in range(n):
            rate = cfg.arrival_rates[s] * mult
            k = int(self._np_random.poisson(rate))
            if k == 0:
                continue
            for _ in range(k):
                dest = int(self._np_random.integers(0, n))
                while dest == s:
                    dest = int(self._np_random.integers(0, n))
                self.queues[s].append([dest, 0])
            self.n_arrived += k

    # ------------------------------------------------------------------
    # train mechanics
    # ------------------------------------------------------------------

    def _eligible(self, dest: int, station: int, direction: int) -> bool:
        """A passenger only boards a train already pointed at their stop."""
        return (dest > station) if direction > 0 else (dest < station)

    def _serve_tick(self, i: int, station: int) -> bool:
        """
        One tick of platform service, rate limited by board_rate.

        Alighting happens first, then boarding, sharing one budget. Returns
        True if service is still unfinished, meaning the train is physically
        obliged to stay another tick.

        The rate limit is the whole ballgame: a train that arrives late finds
        a bigger crowd, needs more ticks to load it, and leaves even later.
        That is bunching, and it is what the policy has to counteract.
        """
        cfg = self.cfg
        budget = cfg.board_rate
        direction = int(self.dir[i])

        # alight
        alighting = int(self.onboard[i, station])
        if alighting > 0:
            k = min(alighting, budget)
            self.onboard[i, station] -= k
            budget -= k

        # board, oldest waiting first
        queue = self.queues[station]
        kept: List[List[int]] = []
        for idx, entry in enumerate(queue):
            dest, waited = entry
            full = int(self.onboard[i].sum()) >= cfg.capacity
            if budget <= 0 or full:
                kept.extend(queue[idx:])
                break
            if not self._eligible(dest, station, direction):
                kept.append(entry)
                continue
            self.onboard[i, dest] += 1
            budget -= 1
            self.boarded_waits.append(int(waited))
            self.n_boarded += 1
        self.queues[station] = kept

        # is there anything left that this train could still do here?
        more_alighting = int(self.onboard[i, station]) > 0
        has_room = int(self.onboard[i].sum()) < cfg.capacity
        more_boarding = has_room and any(
            self._eligible(d, station, direction)
            for d, _ in self.queues[station]
        )
        return more_alighting or more_boarding

    def _count_stranded(self, i: int, station: int) -> int:
        """
        People left on the platform who wanted this train but could not fit.
        Counted once, at departure, so it is a real headcount rather than an
        every-tick double count.
        """
        if int(self.onboard[i].sum()) < self.cfg.capacity:
            return 0
        direction = int(self.dir[i])
        return sum(
            1 for d, _ in self.queues[station]
            if self._eligible(d, station, direction)
        )

    def _advance_train(self, i: int, action: int):
        cfg = self.cfg

        if self.state[i] == DWELLING:
            station = int(round(self.pos[i]))
            self.dwell[i] += 1

            # serve the platform. this is not optional and not the agent's
            # choice: if people are still getting on or off, the train stays.
            service_pending = self._serve_tick(i, station)
            forced_out = self.dwell[i] >= cfg.max_dwell

            if service_pending and not forced_out:
                # obliged to stay. holding was not a decision here, so this
                # does not count as a hold for the reward.
                self.held[i] = False
                return

            if self.dwell[i] < cfg.min_dwell:
                self.held[i] = False
                return

            # service is done. NOW the action means something: leave, or
            # deliberately sit here to open up the gap to the train ahead.
            if action == HOLD and not forced_out:
                self.held[i] = True
                return

            left_behind = self._count_stranded(i, station)
            self.n_stranded_events += left_behind
            self.tick_stranded += left_behind
            self.state[i] = MOVING
            self.dwell[i] = 0
            self.held[i] = False
            return

        # MOVING
        # A train sitting at either end while still pointed outward has to
        # turn before it moves, or it runs off the track. Belt and braces
        # alongside the fix in _ring_to_line.
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
            self.state[i] = DWELLING
            self.dwell[i] = 0

            # bounce at the ends of the line
            if station == 0:
                self.dir[i] = 1
            elif station == cfg.n_stations - 1:
                self.dir[i] = -1

            # no service on the arrival tick itself. the DWELLING branch
            # handles loading from the next tick onward, so dwell length is
            # always driven by how many people are actually there.
        else:
            self.pos[i] = nxt

    # ------------------------------------------------------------------
    # observation, 12 normalized floats
    # ------------------------------------------------------------------

    def _ref_station(self, i: int) -> int:
        """
        The station this train is 'at'. Dwelling means the current platform;
        moving means the one it is heading toward. Gives the policy a
        consistent anchor for the waiting counts.
        """
        cfg = self.cfg
        if self.state[i] == DWELLING:
            s = int(round(self.pos[i]))
        elif self.dir[i] > 0:
            s = int(np.floor(self.pos[i])) + 1
        else:
            s = int(np.ceil(self.pos[i])) - 1
        return max(0, min(cfg.n_stations - 1, s))

    def _station_ahead(self, start: int, direction: int, k: int) -> int:
        """
        The station k stops ahead, following the bounce at the ends.
        Walked one step at a time so reversals land correctly.
        """
        n = self.cfg.n_stations
        s, d = start, direction
        for _ in range(k):
            s += d
            if s >= n - 1:
                s, d = n - 1, -1
            elif s <= 0:
                s, d = 0, 1
        return s

    def _waiting_at(self, s: int) -> int:
        return len(self.queues[s])

    def _headways(self, i: int):
        """Ring gaps to the nearest train ahead and behind, as ratios."""
        cfg = self.cfg
        cyc = cfg.cycle_length
        c_i = self._line_to_ring(self.pos[i], int(self.dir[i]))

        ahead, behind = cyc, cyc
        for j in range(cfg.n_trains):
            if j == i:
                continue
            c_j = self._line_to_ring(self.pos[j], int(self.dir[j]))
            fwd = (c_j - c_i) % cyc
            bwd = (c_i - c_j) % cyc
            if 0 < fwd < ahead:
                ahead = fwd
            if 0 < bwd < behind:
                behind = bwd

        mean = cfg.mean_headway
        return ahead / mean, behind / mean

    def _observe(self, i: int) -> np.ndarray:
        cfg = self.cfg
        cap = float(cfg.capacity)
        n = cfg.n_stations

        ref = self._ref_station(i)
        direction = int(self.dir[i])

        ahead_ratio, behind_ratio = self._headways(i)

        # every waiting count is divided by train capacity, never by anything
        # line specific. "how many trainloads are waiting" is the same
        # question on a 24 station line and an 8 station one.
        here = min(self._waiting_at(ref) / cap, 1.0)

        nxt = []
        for k in range(1, LOOKAHEAD + 1):
            s = self._station_ahead(ref, direction, k)
            nxt.append(min(self._waiting_at(s) / cap, 1.0))

        onboard_total = float(self.onboard[i].sum())

        window = []
        for d in range(-CROWD_WINDOW, CROWD_WINDOW + 1):
            s = ref + d
            if 0 <= s < n:
                window.append(self._waiting_at(s))
        local_wait = float(np.mean(window)) if window else 0.0
        crowding = min((local_wait + onboard_total) / cap, 1.0)

        obs = np.array([
            self.pos[i] / max(1.0, n - 1.0),            # 1  position
            1.0 if direction > 0 else 0.0,              # 2  direction
            min(ahead_ratio, MAX_HEADWAY_RATIO)
            / MAX_HEADWAY_RATIO,                        # 3  headway ahead
            min(behind_ratio, MAX_HEADWAY_RATIO)
            / MAX_HEADWAY_RATIO,                        # 4  headway behind
            onboard_total / cap,                        # 5  load factor
            min(self.dwell[i] / max(1.0, cfg.max_dwell), 1.0),   # 6  dwell
            here,                                       # 7  waiting here
            nxt[0],                                     # 8  waiting +1
            nxt[1],                                     # 9  waiting +2
            nxt[2],                                     # 10 waiting +3
            self.t / max(1.0, cfg.episode_ticks),       # 11 time of day
            crowding,                                   # 12 local crowding
        ], dtype=np.float32)

        return np.clip(obs, 0.0, 1.0)

    # ------------------------------------------------------------------
    # reward, per line
    # ------------------------------------------------------------------

    def _reward(self) -> float:
        """
        -(waiting on this line) - 0.5*(onboard being held) - 2.0*(stranded)

        Computed for the line as a whole and shared by every train on it, so
        trains cannot win by shoving their own queue onto the train behind.

        The constant scale keeps PPO gradients sane. It is a single positive
        multiplier applied to the whole expression, so it does not change
        which policy is optimal.
        """
        waiting = sum(len(q) for q in self.queues)
        held_onboard = float(self.onboard[self.held].sum()) if self.held.any() else 0.0
        beta = self.cfg.hold_penalty
        raw = -(waiting) - beta * held_onboard - 2.0 * self.tick_stranded
        scale = 1.0 / (self.cfg.n_stations * self.cfg.capacity)
        return float(raw * scale)

    # ------------------------------------------------------------------
    # pettingzoo API
    # ------------------------------------------------------------------

    def reset(self, seed: Optional[int] = None, options=None):
        if seed is not None:
            self._np_random = np.random.default_rng(seed)
        self.agents = list(self.possible_agents)
        self._reset_state()

        obs = {a: self._observe(i) for i, a in enumerate(self.agents)}
        infos = {a: {} for a in self.agents}
        if self.record:
            self._capture()
        return obs, infos

    def step(self, actions: Dict[str, int]):
        cfg = self.cfg
        self.tick_stranded = 0
        self.held[:] = False

        self._spawn_passengers()

        for i, a in enumerate(self.agents):
            self._advance_train(i, int(actions.get(a, DEPART)))

        # everyone still on a platform waits one more tick
        for q in self.queues:
            for entry in q:
                entry[1] += 1
        self.total_wait_ticks += sum(len(q) for q in self.queues)

        self.t += 1
        r = self._reward()

        done = self.t >= cfg.episode_ticks
        obs = {a: self._observe(i) for i, a in enumerate(self.agents)}
        rewards = {a: r for a in self.agents}
        terminations = {a: False for a in self.agents}
        truncations = {a: done for a in self.agents}
        infos = {a: {} for a in self.agents}

        if self.record:
            self._capture()

        if done:
            self.agents = []

        return obs, rewards, terminations, truncations, infos

    # ------------------------------------------------------------------
    # metrics and recording
    # ------------------------------------------------------------------

    def _capture(self):
        """
        One frame of raw state. The dumper shapes it to the contract.

        The per-train obs slice is taken straight from _observe, so the
        values written to the run files are byte for byte the ones the
        policy conditioned on at that tick. Anything reconstructed
        downstream would risk disagreeing with the network's actual input,
        which is exactly the failure the interp panel is trying to avoid.
        """
        obs = [self._observe(i) for i in range(self.cfg.n_trains)]
        self.gap_log.append([self._headways(i)[0]
                             for i in range(self.cfg.n_trains)])
        self.frames.append({
            "t": self.t,
            "pos": [round(float(p), 2) for p in self.pos],
            "onboard": [int(self.onboard[i].sum())
                        for i in range(self.cfg.n_trains)],
            "holding": [bool(h) for h in self.held],
            "waiting": [len(q) for q in self.queues],
            "obs": [
                {
                    "headway_ahead_ratio": float(o[OBS_HEADWAY_AHEAD]),
                    "headway_behind_ratio": float(o[OBS_HEADWAY_BEHIND]),
                    "dwell_over_max_dwell": float(o[OBS_DWELL]),
                }
                for o in obs
            ],
        })

    def all_waits(self) -> np.ndarray:
        """
        One entry per passenger who ever arrived.

        Riders still standing on a platform when the episode ends are
        included at the wait they had accumulated. That censors them, so
        their true wait was longer, but leaving them out entirely would let
        a policy look good by stranding people.
        """
        stranded = [e[1] for q in self.queues for e in q]
        return np.array(self.boarded_waits + stranded, dtype=np.float64)

    def wait_percentiles(self) -> dict:
        """p50, p90, p95 and max, plus the share waiting over 10 minutes."""
        w = self.all_waits()
        if len(w) == 0:
            return {"p50": 0.0, "p90": 0.0, "p95": 0.0, "max": 0.0,
                    "n": 0, "over_10min_pct": 0.0}
        # 10 real minutes at the sim's tick length
        over = 10.0 * 60.0 / TICK_SECONDS
        return {
            "p50": float(np.percentile(w, 50)),
            "p90": float(np.percentile(w, 90)),
            "p95": float(np.percentile(w, 95)),
            "max": float(w.max()),
            "n": int(len(w)),
            "over_10min_pct": float(100.0 * np.mean(w > over)),
        }

    def mean_wait(self) -> float:
        """
        Average ticks waited per passenger who ever showed up, including
        anyone still standing on a platform when the episode ends. Stranding
        people makes this worse, not better.
        """
        if self.n_arrived == 0:
            return 0.0
        return self.total_wait_ticks / self.n_arrived

    def headway_cv(self) -> float:
        """
        Coefficient of variation of the gaps between trains. 0 is perfectly
        even spacing. This is the bunching number.
        """
        cfg = self.cfg
        cs = sorted(self._line_to_ring(self.pos[i], int(self.dir[i]))
                    for i in range(cfg.n_trains))
        gaps = [(cs[(k + 1) % len(cs)] - cs[k]) % cfg.cycle_length
                for k in range(len(cs))]
        gaps = np.array(gaps, dtype=np.float64)
        if gaps.mean() <= 0:
            return 0.0
        return float(gaps.std() / gaps.mean())

    def render(self):
        return None

    def close(self):
        return None

    def summary(self) -> dict:
        return {
            "mean_wait": round(self.mean_wait(), 3),
            "headway_cv": round(self.headway_cv(), 3),
            "arrived": self.n_arrived,
            "boarded": self.n_boarded,
            "stranded_events": self.n_stranded_events,
        }


def make_env(config: LineConfig, seed: Optional[int] = None,
             record: bool = False) -> HeadwayEnv:
    return HeadwayEnv(config, seed=seed, record=record)
