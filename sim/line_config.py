"""
Line geometry and demand config for HEADWAY.

A LineConfig is everything the env needs to simulate one subway line. The
whole point is that the env code never hardcodes anything line-specific, so
a policy trained on L can be dropped onto G, 7, 1, 6 with zero changes.

Real MTA numbers get loaded into these by mta_data.py. The synthetic config
here exists so the env can be tested before that lands.
"""

from dataclasses import dataclass, field
from typing import List, Tuple


@dataclass
class LineConfig:
    """One subway line. All the sim needs to know."""

    name: str
    station_names: List[str]
    station_xy: List[Tuple[float, float]]

    # base passenger arrivals per station per tick, off peak.
    # scaled over the episode by the rush hour profile.
    arrival_rates: List[float]

    n_trains: int
    capacity: int = 60

    # track units per tick. 1.0 track unit = one inter-station gap,
    # so 0.25 means 4 ticks to travel between adjacent stations.
    speed: float = 0.25

    # passengers that can board or alight per dwell tick, per train.
    #
    # THIS IS THE MOST IMPORTANT NUMBER IN THE SIM. It is what makes dwell
    # time depend on how many people are waiting, which is what creates
    # bunching: a late train meets a bigger crowd, so it dwells longer, so it
    # falls further behind, so the next crowd is bigger still. Without this
    # feedback loop trains stay evenly spaced on their own and there is
    # nothing for a headway policy to learn.
    board_rate: int = 6

    # a train is forced to depart after this many ticks of dwelling,
    # so a degenerate hold-forever policy cannot deadlock the line.
    max_dwell: int = 12

    # minimum stop time. a train cannot skip a station instantly.
    min_dwell: int = 1

    episode_ticks: int = 900

    # beta, the weight on passengers held aboard a stopped train in the
    # reward. 0.5 is the spec value and what the shipped 012 policy trained
    # with; do not change the default. Raising it should buy less holding,
    # so worse spacing and better wait, which sweep_beta.py measures.
    hold_penalty: float = 0.5

    # gamma, the weight on passengers riding in a moving train, charged
    # every tick they are aboard. 0.0 is the original spec, where the reward
    # only ever counted platform waiting, so nothing pushed toward shorter
    # trips. Default stays 0.0 so the shipped 012 policy's environment is
    # unchanged; the skip-stop experiment raises it.
    in_vehicle_penalty: float = 0.0

    # multiplier on arrival_rates at the peak of the rush.
    peak_multiplier: float = 2.5

    def __post_init__(self):
        n = len(self.station_names)
        if len(self.station_xy) != n:
            raise ValueError(
                f"{self.name}: {len(self.station_xy)} xy coords "
                f"for {n} stations"
            )
        if len(self.arrival_rates) != n:
            raise ValueError(
                f"{self.name}: {len(self.arrival_rates)} arrival rates "
                f"for {n} stations"
            )
        if n < 4:
            raise ValueError(f"{self.name}: need at least 4 stations")
        if self.n_trains < 2:
            raise ValueError(f"{self.name}: need at least 2 trains")

    @property
    def n_stations(self) -> int:
        return len(self.station_names)

    @property
    def cycle_length(self) -> float:
        """
        Trains loop at the ends, so the line unfolds into a ring.

        A line with N stations has N-1 gaps in each direction, giving a ring
        of circumference 2*(N-1). This is what makes headway well defined:
        on a ring, the gap between consecutive trains is unambiguous.
        """
        return 2.0 * (self.n_stations - 1)

    @property
    def mean_headway(self) -> float:
        """Perfectly even spacing. The thing the policy is trying to hit."""
        return self.cycle_length / self.n_trains


def synthetic_line(name: str = "TEST", n_stations: int = 12,
                   n_trains: int = 4, seed: int = 0) -> LineConfig:
    """
    A fake line for testing the env before real MTA data exists.
    Demand is humped in the middle to mimic a trunk with busy core stations.
    """
    import math

    xy = [(60.0 + 50.0 * i, 200.0) for i in range(n_stations)]
    rates = []
    for i in range(n_stations):
        # peak demand in the middle of the line
        u = i / max(1, n_stations - 1)
        hump = math.exp(-((u - 0.5) ** 2) / 0.06)
        rates.append(0.02 + 0.13 * hump)

    return LineConfig(
        name=name,
        station_names=[f"Sta {i}" for i in range(n_stations)],
        station_xy=xy,
        arrival_rates=rates,
        n_trains=n_trains,
        episode_ticks=600,
    )
