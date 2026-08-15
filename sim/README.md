# HEADWAY sim

Multi-agent RL subway headway control. Each train is an agent with one
binary action at a platform: depart, or hold one tick. Every train runs the
same shared weights.

## Setup

Python 3.11 (3.14 has no torch wheels). Every version is pinned, including
transitives, because supersuit and pettingzoo break against each other
constantly.

```
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python smoke_test.py     # plumbing: pettingzoo -> supersuit -> SB3
.venv/bin/python test_env.py       # env correctness and normalization
```

## Files

| file | what it does |
| --- | --- |
| `headway_env.py` | the env. PettingZoo ParallelEnv, one agent per train |
| `line_config.py` | geometry and demand for one line |
| `mta_data.py` | real station lists and ridership, schematic canvas layout |
| `calibrate_service.py` | derives how many trains each line needs |
| `baseline.py` | fixed-headway timetable, the thing to beat |
| `train.py` | PPO on the L, checkpoints at 0/25/50/100 percent |
| `dump.py` | writes `/web/public/runs/{LINE}_{TAG}.json` per `/contract.md` |
| `check_lines.py` | sanity checks every line before training |

## The observation is the whole trick

12 floats, all normalized, all dimensionless. No raw counts, no absolute
positions, no line identifier.

```
position_on_line_normalized, direction, headway_ahead_ratio,
headway_behind_ratio, onboard/capacity, dwell_ticks/max_dwell,
waiting_here_norm, waiting_next_3_norm (x3), time_of_day_norm,
local_crowding_index
```

Waiting counts are divided by train capacity, never by anything line
specific, so "how many trainloads are waiting" means the same thing on a 24
station line and an 8 station one. Headways are divided by the line's own
mean headway, so 1.0 always means perfectly even spacing.

A policy that never sees "24 stations" or "37 people waiting" cannot memorize
the L. That is the entire mechanism behind zero-shot transfer. If a raw count
leaks into this vector the transfer result dies. `test_env.py` asserts every
element stays in [0,1] across 8, 24 and 40 station lines.

## Why dwell time is rate limited

`board_rate` caps how many passengers board per tick. This is the most
important number in the sim.

The first version boarded everyone instantly, so dwell time was constant.
Trains stayed evenly spaced on their own (headway cv 0.025) and holding could
only ever hurt. There was nothing to learn.

Real bunching is a feedback loop: a late train meets a bigger crowd, so it
loads slower, so it falls further behind, so the next crowd is bigger. Rate
limiting dwell reproduces that loop, and bunching now emerges on its own
(cv 0.52 to 1.03 depending on the line). Service is forced while people are
still boarding; the agent only chooses whether to sit there *extra* ticks
after loading finishes.

## Data

data.ny.gov, the state portal:

- stations `39hk-dx4f`
- hourly ridership `wujg-7c2s`, one weekday week, 7 to 10am

Cached to `data/lines.json` and committed, so this runs offline and produces
identical numbers every time. Refresh with `python mta_data.py --refresh`.

Station order comes from `gtfs_stop_id`, which increments along a line. G
needs an explicit prefix order because it crosses to the Culver line at
Hoyt-Schermerhorn.

Canvas x,y are computed here, snapped to 45 degree angles with equal station
spacing. The web side does zero layout math.

### Service levels are calibrated, not tuned

`SERVICE_LEVEL` in `mta_data.py` is the smallest fleet that boards at least
97 percent of arrivals under depart-always. A saturated line boards almost
nobody, and then no holding policy can help, which destroys the learning
signal.

The spread between lines is real ridership, not tuning: the 7 and the 1 carry
roughly three times the G's riders and get 12 and 16 trains against the G's 6.
That is what the MTA does too.

## Known constraints

- Do not pass `seed=` to SB3. It forwards to `env.seed()`, which supersuit's
  `ConcatVecEnv` does not implement. Seed globally with `set_random_seed`.
- The agent set must stay constant for the whole episode. Trains never
  terminate, they just keep looping.
- `render_mode` must exist on the env even though nothing renders, because
  supersuit's `MarkovVectorEnv` reads it at construction.

## Output

`dump.py` is the only thing in sim that writes outside sim, and it writes
nothing except `/web/public/runs/{LINE}_{TAG}.json`. The shape is frozen in
`/contract.md` and `dump.py:validate()` asserts every rule in it before
writing.
