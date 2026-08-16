import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'

import { loadRun, peekRun, FINAL_TAG } from '../runs.js'
import { sampleLine } from '../sample.js'
import { posToXY, boundsOf } from '../geometry.js'
import {
  COLORS,
  makeProjector,
  buildLights,
  buildGround,
  buildTrack,
  buildTrains,
  buildContacts,
  buildRiders,
  buildLabel,
  buildPool,
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
const TICKS_PER_SEC = 6
// Riders waiting per figure shown. Inside the window a platform holds one
// rider at the median and fifteen at its worst, and a full platform is eight
// figures, so a figure is two people. Two thirds of the day sits at nought or
// one, which is what makes a platform that has filled up read as unusual. No
// count appears anywhere.
const RIDERS_PER_FIGURE = 2
// The line the policy was trained on, and the one the comparison runs.
const COMPARE_LINE = 'L'

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
const LOOP_FROM_T = 716
const LOOP_TO_T = 900

// First and last entry inside the window. Both ends are inclusive, so the loop
// runs one full circuit and rejoins itself.
const windowOf = (doc) => {
  const ts = doc.ticks
  let from = 0
  let to = ts.length - 1
  while (from < to && ts[from].t < LOOP_FROM_T) from++
  while (to > from && ts[to].t > LOOP_TO_T) to--
  return { from, to }
}

// Which train a side's camera rides: the one that spends the loop most closed
// up on the train in front. Decided once, from the whole window, rather than
// per frame. Per frame the tightest train changes every three to eight ticks,
// which at this playback rate is a cut every half second, and no amount of
// hysteresis rescues that on the learned side where all seven trains sit
// within a hundredth of each other. Over the window there is a clear worst on
// the timetable side, it is worst for the entire window, and the camera never
// has to move.
function worstSpaced(doc) {
  const { from, to } = windowOf(doc)
  let pick = 0
  let lowest = Infinity
  for (let i = 0; i < doc.ticks[0].trains.length; i++) {
    let acc = 0
    let n = 0
    for (let k = from; k <= to; k++) {
      const r = doc.ticks[k].trains[i].obs?.headway_ahead_ratio
      if (typeof r === 'number') {
        acc += r
        n++
      }
    }
    const mean = n ? acc / n : Infinity
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
const LOOK_AHEAD = 2.2
// Seconds-ish constants. The yaw is slow enough that the camera trails the
// train around a corner and catches up after, rather than snapping to the new
// segment the instant the train crosses the joint. The look point is quicker,
// because that is the lean and it should arrive before the train does.
const YAW_LAG = 1.7
const LOOK_LAG = 2.4
// How far the camera is allowed to fall behind its train, in world units.
// About half a train length of give.
const MAX_SLIP = 1.4

// Shortest signed way from angle a to angle b.
const wrapPi = (d) => ((((d + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI

// What the scene is doing, in one sentence. Reads the same state the visuals
// are already showing, so the line and the world can never disagree.
// An even seven trains sit at a third of the gap ahead of them. The runs put
// the baseline's fifth percentile at 0.24 and the policy's at 0.29, so a
// quarter and a bit is where the two actually part company: below it, twenty
// percent of the timetable day and none of the learned one. Read at 0.18 it
// fired on a handful of ticks in the whole run and the sentence never came up
// at all.
const TIGHT = 0.26

function describe(systems) {
  if (!systems.length) return ''
  const [timetable, learned] = systems
  // The sentence says "this train", so it has to mean the train the camera is
  // on, not any train anywhere in the run.
  const ridden = (sys) => sys?.last?.trains[sys.mountIndex]

  if (ridden(learned)?.holding) return 'this train is holding to let the gap behind close.'

  const front = ridden(timetable)?.obs?.headway_ahead_ratio
  if (typeof front === 'number' && front < TIGHT) {
    return 'the timetable train has closed right up on the one in front.'
  }

  const tight = (sys) =>
    sys?.last?.trains.filter((t) => (t.obs?.headway_ahead_ratio ?? 1) < TIGHT).length || 0
  const bunched = tight(timetable)
  if (bunched >= 2) {
    return `${bunched === 2 ? 'two' : 'three'} trains are bunched together on the timetable side.`
  }

  const deepest = Math.max(0, ...(timetable?.last?.waiting || [0]))
  if (deepest > 14) return 'the platform ahead has been waiting a long time.'
  if (bunched === 1) return 'a train on the timetable side has caught the one in front.'
  return 'both lines are running the same day, with the same riders.'
}

export default function Scene3D({ playing }) {
  const hostRef = useRef(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(null)
  const [say, setSay] = useState('')
  const sayRef = useRef('')
  const playingRef = useRef(playing)
  playingRef.current = playing
  const resetRef = useRef(() => {})

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

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
    renderer.toneMappingExposure = 1.15
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
      const c = new THREE.PerspectiveCamera(58, host.clientWidth / 2 / host.clientHeight, 0.3, 1200)
      return c
    })

    // Orbit is expressed relative to the mount rather than to a fixed target,
    // because the target is a train travelling down a line. OrbitControls
    // assumes a stationary centre and fights a moving one.
    // Close enough behind that the train fills the lower frame and the ties
    // pass under it, low enough that the shot is down the line rather than
    // onto it.
    const HOME = { yaw: 0, pitch: 0.22, dist: 11 }
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
      orbit.tPitch = Math.max(-0.25, Math.min(1.45, orbit.tPitch + (e.clientY - drag.y) * 0.004))
      drag = { x: e.clientX, y: e.clientY }
    }
    const onUp = () => (drag = null)
    const onWheel = (e) => {
      e.preventDefault()
      orbit.tDist = Math.max(6, Math.min(260, orbit.tDist * Math.exp(e.deltaY * 0.0016)))
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

      buildPool(group, 90)

      return {
        docs,
        project,
        group,
        // Each side rides its own worst-spaced train, so the two viewports are
        // usually looking at different places on the line. That is the point:
        // the argument belongs in the middle of both frames, not up the track
        // in one of them.
        mountIndex: worstSpaced(docs[0]),
        // Camera yaw, damped. Held per system for the same reason.
        camYaw: null,
        trains: buildTrains(group, trainCount),
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
      const left = peekRun(COMPARE_LINE, 'baseline')
      const right = peekRun(COMPARE_LINE, FINAL_TAG)
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
            sys.look = null
          }
        }

        // One head for every system, so the comparison is the same moment of
        // the same day on both sides.
        for (const sys of state.systems) {
          let ti = 0
          let ri = 0
          for (const doc of sys.docs) {
            const s2 = sampleLine(doc, Math.min(head, doc.ticks.length - 1))
            sys.last = s2
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
              sys.trains.setMatrixAt(ti, dummy.matrix)

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
                // The place on the line to look at. Clamped at a terminal, so
                // arriving at the end of the line means looking at the end of
                // the line rather than at somewhere the track doubles back to.
                at(sys, s2, tr.pos + LOOK_AHEAD * tr.dir, LEAD)
                sys.target = { x: LEAD.x + WAY.x, z: LEAD.z + WAY.z }
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
          sys.contacts.count = ti
          sys.trains.instanceMatrix.needsUpdate = true
          if (sys.trains.instanceColor) sys.trains.instanceColor.needsUpdate = true
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
        narrate = state.systems.length ? 0.8 : 0
        const s = describe(state.systems)
        if (s !== sayRef.current) {
          sayRef.current = s
          setSay(s)
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

          // The look point eases separately, and cuts with the camera.
          if (!sys.look || jump) sys.look = new THREE.Vector3(sys.target.x, 0, sys.target.z)
          const lk = 1 - Math.exp(-dt * LOOK_LAG)
          sys.look.x += (sys.target.x - sys.look.x) * lk
          sys.look.z += (sys.target.z - sys.look.z) * lk

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
          const up = orbit.dist * Math.sin(orbit.pitch) + 1.6
          // Dragging swings the mount point around the train; the camera goes
          // on looking down the line either way.
          const cy = Math.cos(orbit.yaw)
          const sy = Math.sin(orbit.yaw)
          const bx = -(fx * cy - fz * sy)
          const bz = -(fx * sy + fz * cy)
          cam.position.set(
            px + bx * back - fz * sway,
            py + up + bob,
            pz + bz * back + fx * sway
          )
          cam.lookAt(sys.look.x, py + 1.1, sys.look.z)
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
        peekRun(COMPARE_LINE, tag) ? Promise.resolve() : loadRun(COMPARE_LINE, tag).catch(() => {})
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
        </>
      )}
      {failed && <div className="scene3d-fail mono">{failed}</div>}
      {say && <div className="scene3d-say mono">{say}</div>}
      <button className="scene3d-reset mono" onClick={() => resetRef.current()}>
        reset view
      </button>
      <span className="scene3d-ready" data-ready={ready ? 'yes' : 'no'} />
    </div>
  )
}
