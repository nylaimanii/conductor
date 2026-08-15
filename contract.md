# HEADWAY data contract, FROZEN
sim writes, web reads. neither agent changes this without asking Nyla.

path: /web/public/runs/{LINE}_{TAG}.json
tags: 001, 003, 006, 012, 025, baseline
all five lines (L, G, 7, 1, 6) get all six tags, so 30 files.

025 is the final shipped policy, cut at 5,000,000 timesteps.
tags are log spaced across the region where learning actually happens,
as a percentage of the original 20,000,000 step schedule.
every non-baseline tag on G, 7, 1 and 6 is the L-trained weights run
zero-shot. nothing is retrained per line.

{
  "line": "L",
  "tag": "100",
  "label": "trained",
  "capacity": 60,
  "stations": [{"name": "8 Av", "x": 40, "y": 200}],
  "ticks": [
    {"t": 0,
     "trains": [{"pos": 3.42, "onboard": 12, "holding": false}],
     "waiting": [4, 0, 7]}
  ],
  "metrics": {"mean_wait": 4.21, "baseline_wait": 6.83, "improvement_pct": 38.4}
}

rules:
- pos is a FLOAT STATION INDEX. 3.42 = 42% from station 3 to station 4.
- x,y are canvas coords computed by sim. web does zero layout math.
- waiting is one int per station, same order as stations.
- round pos to 2 decimals, subsample every 2nd tick.
