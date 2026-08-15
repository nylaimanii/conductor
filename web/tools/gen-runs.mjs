// HEADWAY fake run generator.
//
// Emits files matching /contract.md exactly so the renderer can be built before
// sim produces real trajectories. When the real files land they overwrite these
// and no renderer code changes.
//
//   node tools/gen-runs.mjs
//
// Contract points this file must honor:
//   path            /web/public/runs/{LINE}_{TAG}.json
//   tags            every line gets 000 025 050 100 baseline
//   pos             float station index, 3.42 = 42% from station 3 to station 4
//   x, y            canvas coords computed here, web does zero layout math
//   waiting         one int per station, same order as stations
//   rounding        pos to 2 decimals, every 2nd tick written

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = process.env.OUT_DIR || resolve(HERE, '../public/runs')

// Deterministic PRNG so regenerating does not churn every file.
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function seedFrom(str) {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// ---------------------------------------------------------------------------
// Geometry. Vignelli rules: 45 and 90 degrees only, never geographic.
// Every station is the endpoint of a move, so the angles are exact by
// construction rather than by eyeballing coordinates.

const STEP = {
  E: [1, 0],
  W: [-1, 0],
  N: [0, -1],
  S: [0, 1],
  NE: [1, -1],
  NW: [-1, -1],
  SE: [1, 1],
  SW: [-1, 1],
}

function buildStations(names, start, moves, unit) {
  if (moves.length !== names.length - 1) {
    throw new Error(
      `station and move count mismatch: ${names.length} names needs ${names.length - 1} moves, got ${moves.length}`
    )
  }
  let [x, y] = start
  const out = [{ name: names[0], x, y }]
  moves.forEach((m, i) => {
    const [dx, dy] = STEP[m]
    x += dx * unit
    y += dy * unit
    out.push({ name: names[i + 1], x, y })
  })
  return out
}

const LINES = {
  L: {
    capacity: 60,
    trains: 6,
    unit: 52,
    start: [60, 300],
    moves: ['E', 'E', 'E', 'E', 'SE', 'SE', 'E', 'E', 'E', 'E', 'E', 'E'],
    names: [
      '8 Av', '6 Av', 'Union Sq', '3 Av', '1 Av', 'Bedford Av', 'Lorimer St',
      'Graham Av', 'Grand St', 'Montrose Av', 'Morgan Av', 'Jefferson St', 'DeKalb Av',
    ],
  },
  G: {
    capacity: 50,
    trains: 4,
    unit: 40,
    start: [700, 140],
    moves: ['S', 'S', 'S', 'SW', 'S', 'S', 'S', 'SW', 'S', 'S', 'S'],
    names: [
      'Court Sq', '21 St', 'Greenpoint Av', 'Nassau Av', 'Metropolitan Av',
      'Broadway', 'Flushing Av', 'Myrtle Willoughby', 'Bedford Nostrand',
      'Classon Av', 'Clinton Washington', 'Fulton St',
    ],
  },
  7: {
    capacity: 70,
    trains: 5,
    unit: 44,
    start: [920, 90],
    moves: ['SW', 'SW', 'W', 'SW', 'W', 'SW', 'W', 'SW', 'W', 'W', 'W'],
    names: [
      'Flushing Main St', 'Mets Willets Pt', '111 St', '103 St', '90 St Elmhurst',
      '74 St Broadway', '61 St Woodside', 'Queensboro Plaza', 'Court Sq',
      'Grand Central', '5 Av Bryant Pk', 'Times Sq',
    ],
  },
  1: {
    capacity: 55,
    trains: 5,
    unit: 46,
    start: [110, 90],
    moves: ['S', 'S', 'S', 'S', 'S', 'S', 'SE', 'S', 'S', 'S'],
    names: [
      '168 St', '125 St', '96 St', '72 St', 'Times Sq', '34 St Penn', '14 St',
      'Christopher St', 'Chambers St', 'Rector St', 'South Ferry',
    ],
  },
  6: {
    capacity: 65,
    trains: 5,
    unit: 44,
    start: [250, 90],
    moves: ['S', 'S', 'S', 'S', 'S', 'SW', 'S', 'S', 'S', 'S', 'S'],
    names: [
      '125 St', '103 St', '86 St', '68 St Hunter', '59 St', 'Grand Central',
      '33 St', '23 St', 'Union Sq', 'Astor Pl', 'Canal St', 'Brooklyn Bridge',
    ],
  },
}

const envNum = (k, d) => (process.env[k] === undefined ? d : Number(process.env[k]))

// ---------------------------------------------------------------------------
// Run configuration. skill drives how well the policy spaces its trains.

const RUNS = {
  // An untrained policy has not learned to hold at all, so its hold rate is
  // exactly zero rather than merely small. It runs every train as soon as
  // boarding finishes, which is what lets the fleet bunch.
  baseline: { label: 'baseline', skill: 0.0 },
  '000': { label: 'untrained', skill: 0.0 },
  // Spread so each checkpoint is visibly better than the last. Improvement in
  // this system is steeply nonlinear: even a barely calibrated policy removes
  // most of the bunching, so evenly spaced skill values put nearly the whole
  // gain between the first two checkpoints and leave the rest of the scrubber
  // looking inert.
  '025': { label: 'early training', skill: envNum('SKILL_025', 0.14) },
  '050': { label: 'mid training', skill: envNum('SKILL_050', 0.38) },
  '100': { label: 'trained', skill: 0.96 },
}

// Every line is cut at every checkpoint, so the whole network moves together
// as the scrubber crosses each stage.
const ALL_TAGS = ['baseline', '000', '025', '050', '100']
const TAGS_FOR = () => ALL_TAGS

const SIM_TICKS = 400 // every 2nd is written, per the contract
// Ticks simulated before anything is recorded. Two jobs: platforms start
// populated rather than empty, and the uncontrolled fleet has time to actually
// bunch. Bunching is a slow instability, so a short warmup shows an untrained
// line that has not gone wrong yet and makes training look like it did nothing.
const WARMUP_TICKS = envNum('WARMUP_TICKS', 900)
const TICK_MINUTES = 0.1 // one tick is six seconds
// Platform stop, in ticks. NOM is a normal station stop; the policy may
// shorten it toward MIN to make up time or extend it toward MAX to hold.
// Overridable so the tuning sweep can search them without editing this file.
const DWELL_NOM = envNum('DWELL_NOM', 4)
const DWELL_MIN = envNum('DWELL_MIN', 2)
const DWELL_MAX = envNum('DWELL_MAX', 40)
const HOLD_GAIN = envNum('HOLD_GAIN', 10)
// Ticks of dwell per boarding passenger. The bunching feedback lives here: a
// train that slips back loads a bigger crowd, which costs it more time. Too
// small and the fleet is unconditionally stable, so an untrained policy never
// bunches and there is nothing for training to fix.
const BOARD_TICKS = envNum('BOARD_TICKS', 1.3)

const lerp = (a, b, u) => a + (b - a) * u
const round2 = (v) => Math.round(v * 100) / 100

// Passenger demand is a property of the city, not of the policy, so it is
// seeded from the line and station only. Every run of a line therefore faces
// identical demand, which is what makes the split screen comparison fair.
function demandFor(line, stations) {
  const rnd = mulberry32(seedFrom(`demand:${line}`))
  return stations.map((s, i) => {
    const hub = /Sq|Grand Central|Times|Court Sq|Penn/.test(s.name) ? 1.8 : 1
    // Kept well under capacity per headway on purpose. If demand saturates the
    // trains then wait is driven by backlog and spacing stops mattering, which
    // would flatten the whole point of the demo.
    return (0.04 + rnd() * 0.1) * hub * (i === 0 || i === stations.length - 1 ? 0.6 : 1)
  })
}

function simulate(line, cfg, tag) {
  const stations = buildStations(cfg.names, cfg.start, cfg.moves, cfg.unit)
  const nSt = stations.length
  const N = nSt - 1 // last station index
  const CIRCUIT = 2 * N // out and back, so trains never teleport across the map
  const { skill } = RUNS[tag]
  const rnd = mulberry32(seedFrom(`${line}:${tag}`))
  const demand = demandFor(line, stations)

  const baseSpeed = 0.052
  const targetGap = CIRCUIT / cfg.trains

  // Every run of a line starts from the same evenly spaced fleet and faces the
  // same disturbance, drawn from a world seed that ignores the tag. Only the
  // policy differs.
  //
  // Damping the disturbance as the policy improves, or starting the untrained
  // fleet pre bunched, would both bake the result into the setup: the trained
  // run would look better because it was handed an easier world, not because it
  // did anything. Bunching has to emerge from the untrained run on its own.
  const world = mulberry32(seedFrom(`world:${line}`))
  const trains = []
  for (let i = 0; i < cfg.trains; i++) {
    trains.push({
      c: (i * CIRCUIT) / cfg.trains,
      onboard: Math.floor(world() * cfg.capacity * 0.4),
      dwell: 0,
      hold: 0,
      holding: false,
      // Per train speed variation: traffic, signals, driver. A property of the
      // railway, identical across every run of this line.
      wobAmp: 0.3,
      wobFreq: 0.012 + world() * 0.02,
      wobPhase: world() * Math.PI * 2,
    })
  }

  // Two queues per station, one per direction of travel. A rider waits for a
  // train going their way, so a train only clears the queue matching its own
  // direction. Modelling this as a single merged queue makes even spacing look
  // useless, because outbound and inbound arrivals interleave unevenly at every
  // station except the midpoint. The contract still gets one int per station:
  // the two queues are summed on the way out.
  const queueOut = new Array(nSt).fill(0)
  const queueIn = new Array(nSt).fill(0)
  const ticks = []
  let waitAccum = 0
  let boardedTotal = 0
  // Coefficient of variation of the headways, averaged over the run. This is
  // the number the whole demo rests on: wait scales with 1 + cv squared, so
  // cv going down is exactly what "learning to space out" means.
  let cvAccum = 0
  let cvSamples = 0

  const posOf = (c) => {
    const m = ((c % CIRCUIT) + CIRCUIT) % CIRCUIT
    return m <= N ? m : CIRCUIT - m
  }

  for (let k = -WARMUP_TICKS; k < SIM_TICKS; k++) {
    const recording = k >= 0
    for (let s = 0; s < nSt; s++) {
      // Riders at a terminal have only one direction available to them, and
      // the terminal is only ever called by trains in that one direction.
      // Splitting their demand across both queues leaves half of them in a
      // queue no train ever serves, so they pile up on the platform forever.
      if (s === 0) queueOut[s] += demand[s]
      else if (s === N) queueIn[s] += demand[s]
      else {
        queueOut[s] += demand[s] * 0.5
        queueIn[s] += demand[s] * 0.5
      }
    }

    for (let i = 0; i < trains.length; i++) {
      const tr = trains[i]
      tr.holding = false

      if (tr.dwell > 0) {
        tr.dwell--
        // The extra ticks beyond a normal stop are the ones the policy chose.
        if (tr.hold > 0) {
          tr.hold--
          tr.holding = true
        }
        continue
      }

      // Speed carries the disturbance only. The policy has exactly one lever
      // and it is applied at the platform, below.
      const v = baseSpeed * (1 + tr.wobAmp * Math.sin(k * tr.wobFreq + tr.wobPhase))

      // Station arrival is detected in circuit space, not in station space.
      // Every integer of the circuit is one station call: 0..N is the outbound
      // run, N..CIRCUIT is the return. Detecting integer crossings of pos
      // instead silently skips both terminals, because pos only touches 0 and N
      // at the turnaround rather than crossing them, so those two platforms
      // never board anyone and their queues grow without bound.
      const rawC = tr.c + v
      const crossed = Math.floor(rawC) > Math.floor(tr.c)
      const m = Math.floor(rawC) % CIRCUIT
      tr.c = rawC % CIRCUIT

      if (crossed) {
        const st = posOf(m)
        // Outbound trains serve the outbound queue and nobody else.
        const q = m < N ? queueOut : queueIn
        // Riders turn over fast enough that capacity is not the binding
        // constraint. If trains ride full, backlog grows and wait stops
        // tracking headway, which is the number the demo is actually about.
        const alight = Math.round(tr.onboard * (0.3 + rnd() * 0.2))
        tr.onboard -= alight
        const space = cfg.capacity - tr.onboard
        const boarded = Math.min(Math.floor(q[st]), space)
        q[st] -= boarded
        tr.onboard += boarded
        if (recording) boardedTotal += boarded

        // THE POLICY. The only action the agent has is how long to sit at the
        // platform. Running too close behind the train in front, it waits and
        // lets the gap open. Running too far behind, it cuts the stop short and
        // makes time up. Untrained, it always takes the nominal stop, which is
        // why an untrained hold rate is zero rather than merely low.
        //
        // Holding is deliberately the whole mechanism rather than a continuous
        // speed trim. A speed trim equalizes the headways just as well but is
        // invisible on screen and reports a hold rate of zero, so the one thing
        // the agent actually does would never be visible in the demo.
        // Boarding takes time, and that is the whole instability. A train that
        // has slipped back finds a bigger crowd, spends longer loading it, and
        // slips further back, while the train behind finds an empty platform
        // and closes up. Left alone this runs away into bunching, which is what
        // the untrained fleet does. It is also what makes holding worth
        // learning rather than an arbitrary lever.
        const loadTicks = boarded * BOARD_TICKS

        // Training buys two things, and neither of them is a bigger lever.
        //
        // First, the policy learns to use the action at all: an untrained one
        // never holds, a trained one holds whenever the situation calls for it.
        // Second, it learns how long to hold. A half trained policy still holds
        // often, it just misjudges the duration and overshoots or undershoots.
        //
        // Scaling the hold length by skill instead would mean a better policy
        // simply holds harder, which overshoots and makes the fully trained run
        // score worse than the half trained one. More training has to mean
        // better calibrated, not more aggressive.
        let extra = 0
        if (skill > 0 && rnd() < skill) {
          let gap = Infinity
          for (let j = 0; j < trains.length; j++) {
            if (j === i) continue
            let d = trains[j].c - tr.c
            d = ((d % CIRCUIT) + CIRCUIT) % CIRCUIT
            if (d > 0 && d < gap) gap = d
          }
          if (Number.isFinite(gap)) {
            // Positive when this train is too close behind the one in front.
            const err = (targetGap - gap) / targetGap
            const ideal = HOLD_GAIN * err * DWELL_NOM
            // Misjudgement of the duration, shrinking as the policy trains.
            const slip = 1 + (rnd() * 2 - 1) * (1 - skill) * 1.3
            extra = Math.max(0, Math.round(ideal * slip))
          }
        }

        const total = Math.max(
          DWELL_MIN,
          Math.min(DWELL_MAX, Math.round(DWELL_NOM + loadTicks) + extra)
        )
        tr.dwell = total
        // A stop the policy chose to extend is a held stop, and the train is
        // being held for the whole of it, not only for the tail beyond what
        // boarding needed. That is also what reads on screen: the train is
        // sitting at the platform under orders for that entire stop.
        const extended = total > Math.round(DWELL_NOM + loadTicks)
        tr.hold = extended ? total : 0
      }
    }

    if (recording) {
      for (let s = 0; s < nSt; s++) waitAccum += queueOut[s] + queueIn[s]
    }

    {
      const cs = trains.map((tr) => ((tr.c % CIRCUIT) + CIRCUIT) % CIRCUIT).sort((a, b) => a - b)
      const gaps = cs.map((c, i) => (i === cs.length - 1 ? cs[0] + CIRCUIT - c : cs[i + 1] - c))
      const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
      const varr = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length
      if (recording) {
        cvAccum += Math.sqrt(varr) / mean
        cvSamples++
      }
    }

    // Contract: subsample every 2nd tick.
    if (recording && k % 2 === 0) {
      ticks.push({
        t: k,
        trains: trains.map((tr) => ({
          pos: round2(posOf(tr.c)),
          onboard: tr.onboard,
          holding: tr.holding,
        })),
        waiting: queueOut.map((q, s) => Math.floor(q + queueIn[s])),
      })
    }
  }

  // Little's law: average wait equals accumulated queue time over throughput.
  const meanWait = (waitAccum * TICK_MINUTES) / Math.max(1, boardedTotal)
  return { stations, ticks, meanWait, cv: cvAccum / Math.max(1, cvSamples), boarded: boardedTotal }
}

// ---------------------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true })

// Refuse to overwrite sim's real trajectories.
//
// This generator exists only to stand in until sim produces the real runs. Once
// those have landed, running it again silently replaces real output with made
// up numbers, and the two are indistinguishable at a glance. A run is treated
// as sim's if its first station name is not the one this file would have
// written for that line.
//
// Set FORCE_OVERWRITE=1 to regenerate anyway.
if (!process.env.FORCE_OVERWRITE) {
  const foreign = []
  for (const [line, cfg] of Object.entries(LINES)) {
    for (const tag of TAGS_FOR(line)) {
      const path = `${OUT_DIR}/${line}_${tag}.json`
      if (!existsSync(path)) continue
      try {
        const doc = JSON.parse(readFileSync(path, 'utf8'))
        if (doc?.stations?.[0]?.name !== cfg.names[0]) foreign.push(`${line}_${tag}`)
      } catch {
        // Unreadable is not evidence of anything, leave it alone.
      }
    }
  }
  if (foreign.length) {
    console.error(
      `refusing to run: ${foreign.length} file(s) in ${OUT_DIR} were not written by this ` +
        `generator and look like real sim output.\n` +
        `  first few: ${foreign.slice(0, 6).join(', ')}\n` +
        `  regenerating would replace real trajectories with fake ones.\n` +
        `  set FORCE_OVERWRITE=1 if that is genuinely what you want.`
    )
    process.exit(1)
  }
}

let written = 0
for (const [line, cfg] of Object.entries(LINES)) {
  // baseline runs first so the improvement figures have something to divide by.
  const tags = TAGS_FOR(line)
  const results = {}
  for (const tag of tags) results[tag] = simulate(line, cfg, tag)

  const baselineWait = results.baseline.meanWait

  for (const tag of tags) {
    const r = results[tag]
    const doc = {
      line,
      tag,
      label: RUNS[tag].label,
      capacity: cfg.capacity,
      stations: r.stations,
      ticks: r.ticks,
      metrics: {
        mean_wait: round2(r.meanWait),
        baseline_wait: round2(baselineWait),
        improvement_pct: Math.round(((baselineWait - r.meanWait) / baselineWait) * 1000) / 10,
      },
    }
    writeFileSync(`${OUT_DIR}/${line}_${tag}.json`, JSON.stringify(doc))
    written++
    console.log(
      `${line}_${tag}.json  stations=${r.stations.length}  ticks=${r.ticks.length}  ` +
        `mean_wait=${doc.metrics.mean_wait}  improvement=${doc.metrics.improvement_pct}%  cv=${r.cv.toFixed(3)}  boarded=${r.boarded}`
    )
  }
}
console.log(`\nwrote ${written} files to public/runs`)
