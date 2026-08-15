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
//   tags            L gets 000 025 050 100 baseline. G 7 1 6 get 000 100 baseline.
//   pos             float station index, 3.42 = 42% from station 3 to station 4
//   x, y            canvas coords computed here, web does zero layout math
//   waiting         one int per station, same order as stations
//   rounding        pos to 2 decimals, every 2nd tick written

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(HERE, '../public/runs')

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

// ---------------------------------------------------------------------------
// Run configuration. skill drives how well the policy spaces its trains.

const RUNS = {
  baseline: { label: 'baseline', skill: 0.0 },
  '000': { label: 'untrained', skill: 0.06 },
  '025': { label: 'early training', skill: 0.42 },
  '050': { label: 'mid training', skill: 0.71 },
  '100': { label: 'trained', skill: 0.96 },
}

const TAGS_FOR = (line) =>
  line === 'L' ? ['baseline', '000', '025', '050', '100'] : ['baseline', '000', '100']

const SIM_TICKS = 400 // every 2nd is written, per the contract
// Ticks simulated before anything is recorded. Without this the run starts
// with empty platforms, every metric is measured mid transient, and the first
// thing the judge sees is stations with nobody on them.
const WARMUP_TICKS = 320
const TICK_MINUTES = 0.1 // one tick is six seconds
const DWELL_TICKS = 4

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

  // Untrained trains start clumped in pairs. Trained trains start evenly
  // spaced. Everything between is a blend.
  const trains = []
  for (let i = 0; i < cfg.trains; i++) {
    const even = (i * CIRCUIT) / cfg.trains
    const group = Math.floor(i / 2)
    const nGroups = Math.ceil(cfg.trains / 2)
    const bunched = (group * CIRCUIT) / nGroups + (i % 2) * 0.6
    trains.push({
      c: lerp(bunched, even, skill) % CIRCUIT,
      onboard: Math.floor(rnd() * cfg.capacity * 0.4),
      dwell: 0,
      holding: false,
      // Per train speed wobble. This is what makes untrained trains catch each
      // other and bunch. It is damped hard once the policy has learned.
      wobAmp: lerp(0.42, 0.04, skill),
      wobFreq: 0.012 + rnd() * 0.02,
      wobPhase: rnd() * Math.PI * 2,
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
        continue
      }

      let v = baseSpeed * (1 + tr.wobAmp * Math.sin(k * tr.wobFreq + tr.wobPhase))

      // The learned behavior: hold at the platform when you are too close to
      // the train ahead, stretch when you are too far. This is the control law
      // the policy is standing in for, so its strength scales with skill.
      // Proportional control on the gap to the train ahead. Symmetric on
      // purpose: it slows when too close and speeds up when too far by the
      // same factor, so it equalizes headways without inflating the mean.
      // A slow-only rule evens the gaps but stretches average headway, which
      // makes the trained run score worse than the half trained one.
      if (skill > 0.2) {
        let gap = Infinity
        for (let j = 0; j < trains.length; j++) {
          if (j === i) continue
          let d = trains[j].c - tr.c
          d = ((d % CIRCUIT) + CIRCUIT) % CIRCUIT
          if (d > 0 && d < gap) gap = d
        }
        if (Number.isFinite(gap)) {
          const err = (gap - targetGap) / targetGap
          const kp = lerp(0, 0.85, skill)
          const factor = Math.max(0.55, Math.min(1.45, 1 + kp * err))
          v *= factor
          // The train is actively being held back at the platform.
          tr.holding = factor < 0.9
        }
      }

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
        tr.dwell = DWELL_TICKS
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
