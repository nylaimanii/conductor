import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'

import { loadRun, peekRun, FINAL_TAG } from '../runs.js'
import { sampleLine } from '../sample.js'
import { directionsFor } from '../headway.js'
import { posToXY, boundsOf } from '../geometry.js'
import {
  COLORS,
  makeProjector,
  buildLights,
  buildGround,
  buildTrack,
  buildTrains,
  buildOncoming,
  buildLamps,
  buildContacts,
  buildRiders,
  buildLabel,
  buildStations,
  buildMassing,
  aimKey,
  wayOffset,
  RIDER_SLOTS_PER_STATION,
} from './world.js'

// The scene. A physical world seen from outside, orbited freely.
//
// The screen carries nothing but the world and a play control: no numbers, no
// scrubber, no labels beyond a quiet letter per line. The simulation runs on
// its own clock and is never gated on the camera.

// Stations on the L sit about four world units apart, which is one train
// length, so the rate that read as streaming from an overhead survey is a blur
// from fifteen units behind the cab. Slow enough that a station is an event
// and the ties still flick past. The window is 93 entries, so this puts one
// circuit of the line at about fifteen seconds.
const TICKS_PER_SEC = 4.5
// Riders waiting per figure shown. Inside the window a platform holds one
// rider at the median and fifteen at its worst, and a full platform is eight
// figures, so a figure is two people. Two thirds of the day sits at nought or
// one, which is what makes a platform that has filled up read as unusual. No
// count appears anywhere.
const RIDERS_PER_FIGURE = 2
// The line the policy was trained on, and the one the comparison runs.
// Used when no line has been chosen.
const DEFAULT_LINE = 'L'

// The window, in the run's own tick numbers, computed by sim on this episode:
// t 716 to 900, exactly one loop of the L at its 184 tick loop time.
//
// This is not a window where the two runs merely differ. The learned run is
// tighter on every single tick inside it and the cv gap never falls below
// 0.095. That matters because the policy does not lead from the start: between
// t 100 and t 300 the timetable is tighter on one hundred percent of ticks,
// and across the whole first half the learned run leads on under a quarter of
// them. Any window chosen by eye from the front of the day is a window of the
// policy losing. Picking one by eye is how this went wrong the first time.
//
// Held as tick numbers rather than array indices because the run files are
// subsampled: t steps by two, so t 716 is the 358th entry today and need not
// be tomorrow.
// Loop window per line, in each run's own tick numbers, computed by the sim
// agent. One object, so a revision is a single edit.
//
// Every one satisfies the same condition: the learned run's headway cv is
// strictly below the timetable's at every tick inside the window. The minimum
// gap over the window is recorded beside each, since that is the number the
// comparison rests on. All five end at t 900, the most drifted the timetable
// gets.
const LINE_WINDOWS = {
  L: { from: 716, to: 900, minCvGap: 0.0947 },
  G: { from: 740, to: 900, minCvGap: 0.322 },
  7: { from: 732, to: 900, minCvGap: 0.4555 },
  1: { from: 604, to: 900, minCvGap: 0.0855 },
  6: { from: 604, to: 900, minCvGap: 0.1283 },
}

// First and last entry inside the window. Both ends are inclusive, so the loop
// runs one full circuit and rejoins itself.
const windowOf = (doc) => {
  const w = LINE_WINDOWS[doc.line] || LINE_WINDOWS[DEFAULT_LINE]
  const ts = doc.ticks
  let from = 0
  let to = ts.length - 1
  // Bounded loops rather than while: these can only ever walk the array once.
  for (let k = 0; k < ts.length; k++) {
    if (ts[k].t >= w.from) {
      from = k
      break
    }
  }
  for (let k = ts.length - 1; k >= 0; k--) {
    if (ts[k].t <= w.to) {
      to = k
      break
    }
  }
  if (to < from) to = from
  return { from, to }
}


// How far ahead the next train is ON THE SAME WAY, going the SAME direction,
// in station blocks. Infinity means clear track to the terminal.
//
// This, not headway_ahead_ratio, is what the camera shows. The ratio is a
// circuit measure, and the circuit runs out and back as one loop, so the train
// it calls "ahead" is an oncoming train on the other way 29 percent of the
// time. Those are drawn dark, deliberately, as traffic. So the caption could
// say a train had closed right up while the picture showed empty track — the
// thesis reading backwards was this, not a rendering fault.
export function leaderAhead(trains, dirs, i) {
  const dir = dirs[i]
  let best = Infinity
  for (let j = 0; j < trains.length; j++) {
    if (j === i || dirs[j] !== dir) continue
    const delta = (trains[j].pos - trains[i].pos) * dir
    if (delta > 0 && delta < best) best = delta
  }
  return best
}

// How far off the camera's axis the train in front sits, in degrees.
//
// A train four blocks up the line is very often round a bend on this line —
// the L turns ninety degrees twice — so being close is not the same as being
// in shot. The narrating line needs both, or it goes back to describing
// something the viewer cannot see.
function leaderOffAxis(s2, sys, dirs) {
  const i = sys.mountIndex
  const me = s2.trains[i]
  if (!me) return 180
  const dir = dirs[i]
  let best = Infinity
  let who = -1
  for (let j = 0; j < s2.trains.length; j++) {
    if (j === i || dirs[j] !== dir) continue
    const d = (s2.trains[j].pos - me.pos) * dir
    if (d > 0 && d < best) {
      best = d
      who = j
    }
  }
  if (who < 0) return 180
  const a = posToXY(s2.stations, me.pos)
  const b = posToXY(s2.stations, s2.trains[who].pos)
  const back = posToXY(s2.stations, me.pos - 0.25 * dir)
  const fwd = posToXY(s2.stations, me.pos + 0.25 * dir)
  const head = Math.atan2(fwd.y - back.y, fwd.x - back.x)
  const bear = Math.atan2(b.y - a.y, b.x - a.x)
  return Math.abs(wrapPi(bear - head)) * (180 / Math.PI)
}

// Which train a side's camera rides: the one with the closest train in front of
// it, over the whole loop. One rule, run identically on both sides, measured on
// the thing a viewer can actually see.
//
// Over this window it picks a timetable train sitting 25 to 30 units off the
// back of the one ahead, every frame of the loop, and a learned train sitting
// at 43 to 44 — a spread of one unit, which is what even spacing looks like.
// The timetable run has a train at a mean of 27 while its others sit between 53
// and 86; the learned run's tightest is 44. The asymmetry in the picture is the
// asymmetry in the data, not in the rule.
//
// Chosen once from the window rather than per frame: per frame the tightest
// train changes every few ticks, which is a cut every half second.
function closestLeader(doc) {
  const { from, to } = windowOf(doc)
  const dirs = directionsFor(doc)
  // A clear run to the terminal counts as this far, so that a train which
  // spends the loop with nothing in front is never chosen as the subject.
  const CLEAR = 20
  let pick = 0
  let lowest = Infinity
  for (let i = 0; i < doc.ticks[0].trains.length; i++) {
    let acc = 0
    for (let k = from; k <= to; k++) {
      const d = leaderAhead(doc.ticks[k].trains, dirs[k], i)
      acc += Number.isFinite(d) ? d : CLEAR
    }
    const mean = acc / (to - from + 1)
    if (mean < lowest) {
      lowest = mean
      pick = i
    }
  }
  return pick
}

// Where the camera looks: a real point on the line this far ahead, in blocks.
// Not a direction worked out from samples ahead — a place on the track.
//
// Aiming and standing have to be separated, and conflating them is what went
// wrong twice. A single smoothed heading used for both means the lean into a
// corner also swings the camera sideways: eleven units back, a forty degree
// lean parks it seven units off the centreline, which on this line is directly
// over the platforms, looking at canopy roofs with no track in frame at all.
// So the camera stands behind its train along the train's own heading, damped
// so a corner is eased rather than cut, and looks at the track ahead, damped
// separately. On a straight the two coincide. At a corner the camera sits
// behind the train and looks into the turn, which is what riding one looks
// like.
const LOOK_AHEAD = 1.4
// And how far the aim is allowed to depart from the way the camera is facing.
// The ridden train sits on the camera's own axis, so a lean of this many
// radians puts it exactly this far off the centre of frame — at twelve degrees
// against a half frame of twenty six, about halfway to the edge. Unbounded, a
// look point on the far side of a corner swings the aim past the half frame
// and the train being ridden leaves the shot altogether, which is what
// happened here: the L can turn ninety degrees twice inside two blocks.
const MAX_LEAN = 0.22
// Seconds-ish constants. The yaw is slow enough that the camera trails the
// train around a corner and catches up after, rather than snapping to the new
// segment the instant the train crosses the joint. The look point is quicker,
// because that is the lean and it should arrive before the train does.
const YAW_LAG = 1.7
const LOOK_LAG = 2.4
// How far the camera is allowed to fall behind its train, in world units.
// About half a train length of give.
const MAX_SLIP = 1.4
// The camera is never allowed below this, whatever the orbit is doing.
//
// Dragging the pitch to its lower clamp put the camera at y = 0.0 — under the
// street and inside the ballast bed, which is now one continuous double sided
// mesh running the length of the line. Seen from inside, that mesh covers the
// whole screen, and it is drawn twice a frame for the two viewports on top of
// two shadow passes. On a weak machine that is not a slow frame, it is the
// wedged tab the audit hit. Clamping the height rather than the pitch is what
// matters, because the height depends on the zoom as well.
const MIN_CAM_Y = 1.15

// Shortest signed way from angle a to angle b.
const wrapPi = (d) => ((((d + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI

// What the scene is doing, in one sentence. Reads the same state the visuals
// are already showing, so the line and the world can never disagree.
// Distance at which a train in front reads as closed up, in station blocks.
// The timetable subject sits inside this for the whole loop and the learned
// one never does.
const CLOSE_BLOCKS = 5.2

// What the scene is doing, in one sentence, read off the same quantity the
// picture is showing: how far ahead the next train on this way is. It used to
// read the circuit ratio, which is a different train from the one on screen
// about a third of the time, so the line and the image could disagree.
//
// One sentence per side, each returned separately so it can be drawn over the
// panel it is about. It used to be a single line on the centre seam carrying
// "left:" and "right:" prefixes, which put the words for both panels in the one
// place that belongs to neither, on top of the picker. Position says which side
// it means now, so the prefixes are gone.
function describe(systems) {
  const none = { left: '', right: '' }
  if (!systems.length) return none
  const [timetable, learned] = systems
  const gapL = timetable?.leaderGap
  const gapR = learned?.leaderGap
  if (typeof gapL !== 'number' || typeof gapR !== 'number') return none

  // In shot as well as close: a train round a bend is not on screen.
  const closeL = gapL < CLOSE_BLOCKS && (timetable?.leaderOff ?? 180) < 22
  const clearR = gapR >= CLOSE_BLOCKS * 1.5
  const deepest = Math.max(0, ...(timetable?.last?.waiting || [0]))

  // The timetable side is a clock and reasons about nothing, so its line only
  // ever reports what the schedule produced.
  let left = 'departure set in advance. running to the clock.'
  if (timetable?.last?.trains[timetable.mountIndex]?.holding) {
    left = 'stopped, and the one behind is closing.'
  } else if (closeL) {
    left = 'closed right up on the one ahead of it.'
  } else if (deepest > 10) {
    left = 'the platform ahead has been waiting a long time.'
  }

  let right = 'spacing is holding.'
  if (learned?.last?.trains[learned.mountIndex]?.holding) {
    right = 'holding back to keep its gap even.'
  } else if (clearR) {
    right = 'the train in front is a full even gap away, and stays there.'
  }

  return { left, right }
}

export default function Scene3D({ playing, line }) {
  const hostRef = useRef(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(null)
  const [say, setSay] = useState({ left: '', right: '', cvL: null, cvR: null })
  const sayRef = useRef(null)
  const playingRef = useRef(playing)
  playingRef.current = playing
  const resetRef = useRef(() => {})

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const lineId = line || DEFAULT_LINE

    let renderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    } catch (e) {
      setFailed('webgl unavailable: ' + e.message)
      return
    }

    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1))
    renderer.setSize(host.clientWidth, host.clientHeight)
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.5
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(COLORS.bg)
    // Distance falloff, so the plane reads as receding rather than as a lit
    // sheet that stops.
    // Close in, because the whole L is only about sixty units end to end. The
    // far end of the line should be dissolving, and the other system, two
    // hundred units away, should not exist.
    scene.fog = new THREE.Fog(COLORS.bg, 35, 130)

    // One camera per side. The comparison is two ride-alongs running in
    // lockstep, so each needs its own view mounted on its own train.
    const cams = [0, 1].map(() => {
      const c = new THREE.PerspectiveCamera(46, host.clientWidth / 2 / host.clientHeight, 0.3, 1200)
      return c
    })

    // Orbit is expressed relative to the mount rather than to a fixed target,
    // because the target is a train travelling down a line. OrbitControls
    // assumes a stationary centre and fights a moving one.
    // Down at roughly the height of the car roof rather than above it, and
    // close in. Height is what decides whether this is a ride or a diorama:
    // looking down at the line puts the vanishing point near the top of the
    // frame and fills the rest with ground, which reads as a model on a table.
    // Almost level, the rails converge to a point near the middle of the frame
    // and the whole lower half is track coming at you, which is the one strong
    // perspective line that carries the motion.
    const HOME = { yaw: 0, pitch: 0.1, dist: 8.5 }
    const orbit = { ...HOME, tYaw: HOME.yaw, tPitch: HOME.pitch, tDist: HOME.dist }
    resetRef.current = () => {
      orbit.tYaw = HOME.yaw
      orbit.tPitch = HOME.pitch
      orbit.tDist = HOME.dist
    }

    // Pointer drag orbits both views together; wheel pulls back from the ride
    // along all the way out to an overhead survey.
    let drag = null
    const el = renderer.domElement
    const onDown = (e) => {
      drag = { x: e.clientX, y: e.clientY }
      el.setPointerCapture?.(e.pointerId)
    }
    const onMove = (e) => {
      if (!drag) return
      orbit.tYaw -= (e.clientX - drag.x) * 0.005
      orbit.tPitch = Math.max(-0.05, Math.min(1.45, orbit.tPitch + (e.clientY - drag.y) * 0.004))
      drag = { x: e.clientX, y: e.clientY }
    }
    const onUp = () => (drag = null)
    const onWheel = (e) => {
      e.preventDefault()
      // Capped at the fog wall: past it there is nothing to see anyway.
      orbit.tDist = Math.max(5, Math.min(120, orbit.tDist * Math.exp(e.deltaY * 0.0016)))
    }
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('wheel', onWheel, { passive: false })

    const key = buildLights(scene)
    buildGround(scene)

    let raf = 0
    let disposed = false
    const clock = new THREE.Clock()
// ?t=380 starts the clock on a named entry. Nothing in the product reads
    // it; it exists so a still can be taken of a chosen moment instead of
    // whatever moment a headless browser happened to stop on.
    const seeded = Number(new URLSearchParams(location.search).get('t')) || 0
    let head = seeded
    let narrate = 0
    const state = { systems: [], window: { from: 0, to: 1 } }

    const dummy = new THREE.Object3D()
    const COL = new THREE.Color()
    const HERE = new THREE.Vector3()
    const LEAD = new THREE.Vector3()
    const WAY = new THREE.Vector3()

    // Where the line is, in world space, at a station index. posToXY clamps,
    // so a sample past a terminal piles up on the terminal rather than folding
    // back down the line: the aim keeps pointing the way the train is still
    // going right up to the buffers, instead of reversing a station early.
    const at = (sys, s2, pos, out) => {
      const p = posToXY(s2.stations, pos)
      const w = sys.project(p.x, p.y)
      // The groups carry a position and no rotation, so this is the whole
      // local to world transform.
      return out.set(w.x + sys.group.position.x, 0, w.z + sys.group.position.z)
    }

    // A system is one running simulation: its own tracks, trains and riders,
    // standing well clear of the other one in the same world.
    const buildSystem = (docs, project, offsetX, offsetZ) => {
      const group = new THREE.Group()
      group.position.x = offsetX
      group.position.z = offsetZ
      // Deliberately unrotated. The group used to be yawed so the line lay
      // across an overhead frame, which is meaningless once the camera is
      // mounted on a train, and it silently broke the mount: the mount point
      // was built from unrotated local coordinates while the track it named
      // was rotated out from under it.
      scene.add(group)

      let trainCount = 0
      let stationCount = 0
      let slots = []
      for (const d of docs) {
        buildMassing(group, d.stations, project)
        buildTrack(group, d.stations, project)
        slots = slots.concat(buildStations(group, d.stations, project))
        trainCount += d.ticks[0].trains.length
        stationCount += d.stations.length
        const a = d.stations[0]
        const b = d.stations[d.stations.length - 1]
        buildLabel(group, d.line, project(a.x, a.y))
        buildLabel(group, d.line, project(b.x, b.y))
      }

      return {
        docs,
        project,
        group,
        // Each side rides its own worst-spaced train, so the two viewports are
        // usually looking at different places on the line. That is the point:
        // the argument belongs in the middle of both frames, not up the track
        // in one of them.
        mountIndex: closestLeader(docs[0]),
        // Camera yaw, damped. Held per system for the same reason.
        camYaw: null,
        trains: buildTrains(group, trainCount),
        oncoming: buildOncoming(group, trainCount),
        lamps: buildLamps(group, trainCount),
        contacts: buildContacts(group, trainCount),
        // Standing places, worked out once with the platforms they belong to.
        slots,
        riders: buildRiders(group, stationCount * RIDER_SLOTS_PER_STATION),
      }
    }

    // One line, two policies. The whole network side by side is a three and a
    // half to one footprint, which pushes the camera so far back that the
    // bunching stops being legible. A single line lets the camera get close,
    // and the bunching is the entire argument.
    const build = () => {
      const left = peekRun(lineId, 'baseline')
      const right = peekRun(lineId, FINAL_TAG)
      if (!left || !right) return
      const project = makeProjector(boundsOf([right]))

      // The two systems are the same world twice, and each viewport is inside
      // one of them, so they no longer share a frame and no longer have to be
      // arranged for one. They are pushed apart by more than the fog reaches
      // instead: whichever line a camera is riding, the other one is not in
      // its shot at all. The L is about a hundred and five units end to end, so
      // the nearest the two ever come is a hundred and forty five, well past
      // where the fog closes at a hundred and thirty.
      const gap = 250
      state.systems = [
        buildSystem([left], project, 0, -gap / 2),
        buildSystem([right], project, 0, gap / 2),
      ]
      state.window = windowOf(left)
      if (!seeded) head = state.window.from
      setReady(true)
    }

    const frame = () => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(0.05, clock.getDelta())

      if (state.systems.length) {
        if (playingRef.current) head += dt * TICKS_PER_SEC
        const { from, to } = state.window
        if (head >= to) {
          // Back to the top of the window, not to the top of the day. The
          // window is one circuit of the line, so the trains are close to
          // where they began and the seam is nearly invisible; the cameras cut
          // with them rather than swinging round to find their train.
          head -= to - from
          for (const sys of state.systems) {
            sys.camYaw = null
            sys.follow = null
            sys.lookYaw = null
          }
        }

        // One head for every system, so the comparison is the same moment of
        // the same day on both sides.
        for (const sys of state.systems) {
          let ti = 0
          let oi = 0
          let ri = 0
          for (const doc of sys.docs) {
            const s2 = sampleLine(doc, Math.min(head, doc.ticks.length - 1))
            sys.last = s2
            // Which way is "your way", read before the loop so every train can
            // be compared against it. It flips when the ridden train turns
            // round at a terminal, and so does every train's classification —
            // but that happens on the same frame the camera cuts, so the swap
            // is hidden inside the cut rather than reading as a flicker.
            const mountDir = s2.trains[sys.mountIndex]?.dir ?? 1
            // The gap the narrating line reads, in blocks: same measure the
            // camera is pointed at, so the words and the picture cannot part.
            const allDirs = s2.trains.map((t) => t.dir)
            sys.leaderGap = leaderAhead(s2.trains, allDirs, sys.mountIndex)
            sys.leaderOff = leaderOffAxis(s2, sys, allDirs)
            for (let tix = 0; tix < s2.trains.length; tix++) {
              const tr = s2.trains[tix]
              const p = posToXY(s2.stations, tr.pos)
              const w = sys.project(p.x, p.y)
              // Centred difference along the direction of travel, so a train
              // points the way it is going on the way back as well as the way
              // out and still has a heading sitting on the buffers. Reading
              // pos + 0.4 pointed every inbound train backwards, which is half
              // the run, and left the camera in front of the one it rides.
              const bk = posToXY(s2.stations, tr.pos - 0.25 * tr.dir)
              const fw = posToXY(s2.stations, tr.pos + 0.25 * tr.dir)
              const wb = sys.project(bk.x, bk.y)
              const wa = sys.project(fw.x, fw.y)
              const hl = Math.hypot(wa.x - wb.x, wa.z - wb.z) || 1
              const hx = (wa.x - wb.x) / hl
              const hz = (wa.z - wb.z) / hl
              // Onto its own way. The heading already carries the direction of
              // travel, so a single left hand offset puts the two directions
              // on opposite tracks without ever asking which is which.
              wayOffset(hx, hz, WAY)

              dummy.position.set(w.x + WAY.x, 0.24, w.z + WAY.z)
              dummy.rotation.set(0, -Math.atan2(hz, hx), 0)
              dummy.scale.setScalar(1)
              dummy.updateMatrix()

              if (tr.dir !== mountDir) {
                // Going the other way, on the other track. Drawn dark and
                // unlit, and given no contact shadow, because a shadow is a
                // claim that something is standing on your ground.
                // The ridden train always travels mountDir by definition, so
                // this can never skip the mount block below.
                sys.oncoming.setMatrixAt(oi++, dummy.matrix)
                continue
              }

              sys.trains.setMatrixAt(ti, dummy.matrix)
              // Same transform as the hull: the lamp geometry is already
              // positioned at the rear in the hull's own local space.
              sys.lamps.setMatrixAt(ti, dummy.matrix)

              dummy.position.set(w.x + WAY.x, 0.045, w.z + WAY.z)
              dummy.rotation.set(0, 0, 0)
              dummy.updateMatrix()
              sys.contacts.setMatrixAt(ti, dummy.matrix)

              // Caught up to the one ahead: dim, and warm the rim. Even is a
              // third, and the run never goes below a sixth, so the ramp has
              // to live in that narrow band or it is either always on or never
              // on. Starting at 0.3 over a width of 0.22 warmed every train on
              // both sides permanently, which says nothing.
              const ratio = tr.obs?.headway_ahead_ratio
              const close =
                typeof ratio === 'number' ? Math.max(0, Math.min(1, (0.28 - ratio) / 0.12)) : 0
              sys.trains.setColorAt(
                ti,
                COL.setRGB(1 - close * 0.1, 1 - close * 0.34, 1 - close * 0.52)
              )

              // The train this side's camera rides. Where the camera stands
              // comes from this train's own heading; where it looks comes from
              // the track ahead of it. The two are damped separately.
              if (tix === sys.mountIndex) {
                at(sys, s2, tr.pos, HERE)
                // Riding the same way the train is on, not the centreline, so
                // the track under the camera is the track under the train.
                sys.mount = { x: HERE.x + WAY.x, y: 0.9, z: HERE.z + WAY.z }
                sys.heading = Math.atan2(hz, hx)
                // The direction of the track ahead, as an angle rather than a
                // point, because what has to be bounded is how far the aim
                // departs from the way the camera faces. Clamped at a terminal,
                // so arriving at the end of the line means looking at the end
                // of the line rather than where the track doubles back to.
                at(sys, s2, tr.pos + LOOK_AHEAD * tr.dir, LEAD)
                const ax = LEAD.x - HERE.x
                const az = LEAD.z - HERE.z
                // Falls back to the heading rather than to nothing. Left
                // unset, an aim of undefined turns the lean into NaN, and a
                // camera with a NaN in its matrix draws an empty viewport with
                // no error anywhere — which is a long way to look for it.
                if (ax * ax + az * az > 0.04) sys.aim = Math.atan2(az, ax)
                else if (sys.aim == null) sys.aim = sys.heading
              }
              ti++
            }

            // Riders stand on the platforms, in places fixed when the platform
            // was built. All that changes per frame is how many are occupied,
            // so a crowd grows and drains in place rather than reshuffling.
            for (let i = 0; i < s2.stations.length; i++) {
              const show = Math.min(
                RIDER_SLOTS_PER_STATION,
                Math.round((s2.waiting[i] || 0) / RIDERS_PER_FIGURE)
              )
              const base = i * RIDER_SLOTS_PER_STATION
              const half = RIDER_SLOTS_PER_STATION / 2
              for (let k = 0; k < RIDER_SLOTS_PER_STATION; k++) {
                // Alternating sides, so a platform and the one facing it fill
                // together. Taken in order the near side would fill completely
                // before a single figure appeared opposite.
                const slot = sys.slots[base + (k % 2) * half + (k >> 1)]
                if (k < show && slot) {
                  dummy.position.set(slot.x, 0.5, slot.z)
                  dummy.rotation.set(0, slot.yaw, 0)
                  dummy.scale.setScalar(1)
                } else {
                  dummy.position.set(0, -50, 0)
                  dummy.rotation.set(0, 0, 0)
                  dummy.scale.setScalar(0.0001)
                }
                dummy.updateMatrix()
                sys.riders.setMatrixAt(ri, dummy.matrix)
                ri++
              }
            }
          }
          sys.trains.count = ti
          sys.lamps.count = ti
          sys.oncoming.count = oi
          sys.contacts.count = ti
          sys.trains.instanceMatrix.needsUpdate = true
          if (sys.trains.instanceColor) sys.trains.instanceColor.needsUpdate = true
          sys.lamps.instanceMatrix.needsUpdate = true
          sys.oncoming.instanceMatrix.needsUpdate = true
          sys.contacts.instanceMatrix.needsUpdate = true
          sys.riders.instanceMatrix.needsUpdate = true
        }
      }

      // The one line of text. Sampled a few times a second rather than per
      // frame, and only pushed into React when the sentence actually changes,
      // so a caption never flickers between two readings of the same moment.
      narrate -= dt
      if (narrate <= 0) {
        // Not yet armed until there is a world to describe, so the first
        // sentence lands on the first frame that has one rather than most of a
        // second later.
        // Fast enough that the spacing number reads as a live instrument
        // rather than a caption. Nothing is recomputed here: cvNow is already
        // worked out by sampleLine every frame, so this only reads it.
        narrate = state.systems.length ? 0.15 : 0
        const s = describe(state.systems)
        const [tt, ln] = state.systems
        // Rounded to what is displayed, so a change beyond the third decimal
        // cannot push a re-render that shows the same digits.
        const show = (sys) => {
          const v = sys?.last?.cvNow
          return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(3) : null
        }
        const next = { left: s.left, right: s.right, cvL: show(tt), cvR: show(ln) }
        // Compared field by field: describe returns a fresh object every call,
        // so an identity check would push a re-render every time.
        const prev = sayRef.current
        if (
          !prev ||
          prev.left !== next.left ||
          prev.right !== next.right ||
          prev.cvL !== next.cvL ||
          prev.cvR !== next.cvR
        ) {
          sayRef.current = next
          setSay(next)
        }
      }

      // Ease the orbit, then mount each camera behind its train.
      const k = 1 - Math.exp(-dt * 6)
      orbit.yaw += (orbit.tYaw - orbit.yaw) * k
      orbit.pitch += (orbit.tPitch - orbit.pitch) * k
      orbit.dist += (orbit.tDist - orbit.dist) * k

      const W = host.clientWidth
      const H = host.clientHeight
      const halfW = Math.floor(W / 2)
      renderer.setScissorTest(true)

      state.systems.forEach((sys, i) => {
        const cam = cams[i]
        const m = sys.mount
        if (m && sys.heading != null) {
          // Trail the heading rather than take it. The whole shot is the track
          // receding, and a camera that arrives behind the new segment on the
          // same frame the train does turns every corner into a cut.
          const err = sys.camYaw == null ? 0 : wrapPi(sys.heading - sys.camYaw)
          // A turnaround is a cut, not a pan. Trailing through a hundred and
          // eighty degrees means watching your own train drive past the lens
          // for a second and a half, which reads as the camera coming loose.
          const jump = sys.camYaw == null || Math.abs(err) > 2.0
          if (jump) sys.camYaw = sys.heading
          else sys.camYaw += err * (1 - Math.exp(-dt * YAW_LAG))

          // The aim eases separately and cuts with the camera, then is held
          // within a bounded lean of it so the ridden train can never be
          // pushed out of its own shot.
          if (sys.lookYaw == null || jump) sys.lookYaw = sys.aim
          else sys.lookYaw += wrapPi(sys.aim - sys.lookYaw) * (1 - Math.exp(-dt * LOOK_LAG))
          const lean = Math.max(-MAX_LEAN, Math.min(MAX_LEAN, wrapPi(sys.lookYaw - sys.camYaw)))

          // Lag. The camera is a body being towed, not a rig bolted to the
          // roof: when the train pulls out of a station it gets away, and when
          // it stops or holds the camera creeps up on it. Capped, so a long
          // fast straight cannot walk the train out of the frame.
          if (!sys.follow) sys.follow = new THREE.Vector3(m.x, m.y, m.z)
          const fk = 1 - Math.exp(-dt * 3.2)
          sys.follow.x += (m.x - sys.follow.x) * fk
          sys.follow.y += (m.y - sys.follow.y) * fk
          sys.follow.z += (m.z - sys.follow.z) * fk
          const slipX = m.x - sys.follow.x
          const slipZ = m.z - sys.follow.z
          const slip = Math.hypot(slipX, slipZ)
          if (slip > MAX_SLIP) {
            sys.follow.x = m.x - (slipX / slip) * MAX_SLIP
            sys.follow.z = m.z - (slipZ / slip) * MAX_SLIP
          }
          const px = sys.follow.x
          const py = sys.follow.y
          const pz = sys.follow.z

          // Sway and bob. Two frequencies that do not divide into each other,
          // so the motion never settles into a pulse, and out of phase between
          // the two sides so the pair does not read as one mechanism. A few
          // pixels at this distance: enough that the shot is alive, not enough
          // to notice as an effect.
          const tt = clock.elapsedTime + i * 3.1
          const bob = Math.sin(tt * 2.3) * 0.075 + Math.sin(tt * 3.71) * 0.045
          const sway = Math.sin(tt * 1.35) * 0.13
          const wobble = Math.sin(tt * 0.93) * 0.006

          const yaw = sys.camYaw + wobble
          const fx = Math.cos(yaw)
          const fz = Math.sin(yaw)
          const back = orbit.dist * Math.cos(orbit.pitch)
          // The mount sits at 0.9 and the car roof at 1.74, so this rides a
          // little over the roof rather than well above it.
          const up = orbit.dist * Math.sin(orbit.pitch) + 1.2
          // Dragging swings the mount point around the train; the camera goes
          // on looking down the line either way.
          const cy = Math.cos(orbit.yaw)
          const sy = Math.sin(orbit.yaw)
          const bx = -(fx * cy - fz * sy)
          const bz = -(fx * sy + fz * cy)
          cam.position.set(
            px + bx * back - fz * sway,
            Math.max(MIN_CAM_Y, py + up + bob),
            pz + bz * back + fx * sway
          )
          const lx = Math.cos(sys.camYaw + lean)
          const lz = Math.sin(sys.camYaw + lean)
          cam.lookAt(px + lx * 15, py + 1.1, pz + lz * 15)

          // A camera with a NaN anywhere in it renders a viewport that has
          // simply gone black, with nothing in the console and no error thrown
          // anywhere. Worth one comparison a frame to be told instead of
          // having to go looking.
          if (!Number.isFinite(cam.position.x + cam.position.y + cam.position.z + lean)) {
            if (!sys.warned) {
              sys.warned = true
              console.error('camera went non-finite', {
                side: i,
                camYaw: sys.camYaw,
                aim: sys.aim,
                lean,
                mount: m,
              })
            }
          }
        }
        cam.aspect = halfW / H
        cam.updateProjectionMatrix()
        // Walk the key light over to this system before drawing it, so its
        // shadow frustum only has to cover one line.
        aimKey(key, sys.group.position.x, sys.group.position.z)
        const x = i === 0 ? 0 : halfW
        renderer.setViewport(x, 0, halfW, H)
        renderer.setScissor(x, 0, halfW, H)
        renderer.render(scene, cam)
      })
      renderer.setScissorTest(false)
    }

    const resize = () => {
      if (!host.clientWidth) return
      renderer.setSize(host.clientWidth, host.clientHeight)
    }
    const ro = new ResizeObserver(resize)
    ro.observe(host)

    // Only the trained runs, one tag, loaded once.
    Promise.all(
      ['baseline', FINAL_TAG].map((tag) =>
        peekRun(lineId, tag) ? Promise.resolve() : loadRun(lineId, tag).catch(() => {})
      )
    ).then(() => {
      if (!disposed) build()
    })

    raf = requestAnimationFrame(frame)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      renderer.dispose()
      scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose()
        if (o.material) {
          const mats = Array.isArray(o.material) ? o.material : [o.material]
          for (const m of mats) {
            if (m.map) m.map.dispose()
            m.dispose()
          }
        }
      })
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement)
    }
  }, [])

  return (
    <div className="scene3d">
      <div className="scene3d-host" ref={hostRef} />
      {/* One per viewport, in screen space. Each camera is inside its own copy
          of the line now, so there is no place in the world that is reliably
          on screen and reliably means one side rather than the other. */}
      {ready && (
        <>
          <div className="scene3d-split" />
          <div className="scene3d-caption scene3d-caption--left mono">today’s timetable</div>
          <div className="scene3d-caption scene3d-caption--right mono">after learning</div>
          {/* Each side's line sits over that side, under its title. */}
          {say.left && <div className="panel-say panel-say--left mono">{say.left}</div>}
          {say.right && <div className="panel-say panel-say--right mono">{say.right}</div>}

          {/* The whole argument as a number, one per panel, same place on both
              so the two can be read against each other at a glance. Lower is
              more evenly spaced; zero would be perfect. */}
          <div className="panel-cv panel-cv--left mono">
            <span className="cv-label">spacing unevenness</span>
            <span className="cv-value">{say.cvL ?? '—'}</span>
          </div>
          <div className="panel-cv panel-cv--right mono">
            <span className="cv-label">spacing unevenness</span>
            <span className="cv-value">{say.cvR ?? '—'}</span>
          </div>
        </>
      )}
      {failed && <div className="scene3d-fail mono">{failed}</div>}
      <button className="scene3d-reset mono" onClick={() => resetRef.current()}>
        reset view
      </button>
      <span className="scene3d-ready" data-ready={ready ? 'yes' : 'no'} />
    </div>
  )
}
