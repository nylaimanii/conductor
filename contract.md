# HEADWAY data contract, FROZEN
sim writes, web reads. neither agent changes this without asking Nyla.

path: /web/public/runs/{LINE}_{TAG}.json
tags: 000, 001, 003, 006, 012, baseline
all five lines (L, G, 7, 1, 6) get all six tags, so 30 files.

000 is the untrained network, saved before any gradient step. it is the
honest "before learning" anchor.
012 is the final shipped policy, cut at 2,400,048 timesteps, and carries
the "trained" label.

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
     "trains": [{"pos": 3.42, "onboard": 12, "holding": false,
                 "obs": {"headway_ahead_ratio": 0.33,
                         "headway_behind_ratio": 0.41,
                         "dwell_over_max_dwell": 0.20}}],
     "waiting": [4, 0, 7]}
  ],
  "metrics": {"mean_wait": 4.21, "baseline_wait": 6.83, "improvement_pct": 38.4}
}

rules:
- pos is a FLOAT STATION INDEX. 3.42 = 42% from station 3 to station 4.
- x,y are canvas coords computed by sim. web does zero layout math.
- waiting is one int per station, same order as stations.
- round pos to 2 decimals, subsample every 2nd tick.

obs, per train:
these are the exact normalized values the policy conditions on, copied
straight out of the observation vector, not reconstructed. do not try to
recover them from pos or from anything else in this file. all three are
dimensionless, in [0,1], rounded to 2 decimals like pos.

- headway_ahead_ratio  = gap to the train ahead, divided by this line's own
                         mean headway, clipped at 3, then divided by 3.
                         so 0.33 is perfectly even spacing, below 0.33 means
                         caught up to the train in front, above means
                         running late.
- headway_behind_ratio = same, for the gap to the train behind.
- dwell_over_max_dwell = ticks spent dwelling divided by max_dwell.
                         0 while in motion.

the interp panel axes in /web/public/interp/ use the same normalization, so
these values plot directly onto the boundary maps with no rescaling.
