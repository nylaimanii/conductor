# Directory ownership

`web/public/runs/` and `web/public/interp/` are written by sim. The web app
reads them and never writes, generates or backfills a file in either.

If a run or a boundary the app needs is absent, the app names the missing file
on screen and in the console, and stops there. It does not stand one in.

The reason is specific rather than procedural. These files are measurements of
a policy: the trajectories it produced, and slices through its decision
surface. A generated stand-in is indistinguishable from a measurement at a
glance, and reads as evidence about a network that was never run. A missing
file is a visible gap. An invented one is a false claim, and a decision surface
for a checkpoint nobody evaluated is a false claim about what a neural network
learned.

Both fake-data generators that used to live in `web/tools/` have been removed
for this reason. They existed so the renderer could be built before sim had
produced anything, and every file they were standing in for now exists.
