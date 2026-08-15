# HEADWAY data contract, FROZEN
sim writes, web reads. neither agent changes this without asking Nyla.

path: /web/public/runs/{LINE}_{TAG}.json
tags: 000, 025, 050, 100, baseline
L gets all five. G, 7, 1, 6 get 000, 100, baseline.

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
