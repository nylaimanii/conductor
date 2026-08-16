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
  wayOffset,
} from './world.js'

// The scene. A physical world seen from outside, orbited freely.
//
// The screen carries nothing but the world and a play control: no numbers, no
// scrubber, no labels beyond a quiet letter per line. The simulation runs on
// its own clock and is never gated on the camera.

// Stations on the L sit about four world units apart, which is one train
// length, so the rate that read as streaming from an overhead survey is a blur
// from fifteen units behind the cab. Slow enough that a station is an event
// and the ties still flick past.
const TICKS_PER_SEC = 10
// Riders are deliberately sparse. A platform shows at most this many, with no
// count anywhere. The crowd is a texture, not a readout.
const RIDERS_PER_STATION = 4
// The line the policy was trained on, and the one the comparison runs.
const COMPARE_LINE = 'L'
// Both sides ride the same train index, so the two views stay comparable.
const MOUNT_INDEX = 0

// How far ahead the camera aims, in station indices along the circuit, and how
// much each sample counts. The near samples dominate so the shot stays down
// the track the train is actually on; the far ones are what make the camera
// lean into a corner a beat before the train reaches it instead of discovering
// it. Aiming at the current segment alone is what made the L read as an
// elevated three quarter shot: the line turns ninety degrees twice, and a
// camera that re-aims every segment never settles into looking down anything.
const AIM = [
  [1.0, 0.42],
  [2.0, 0.26],
  [3.2, 0.16],
  [4.6, 0.1],
  [6.5, 0.06],
]
// Seconds-ish constant on the camera yaw. Low enough that the camera trails
// the train around a corner and catches up after, rather than snapping to the
// new segment the instant the train crosses the joint.
const YAW_LAG = 1.7

// Shortest signed way from angle a to angle b.
const wrapPi = (d) => ((((d + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI

// What the scene is doing, in one sentence. Reads the same state the visuals
// are already showing, so the line and the world can never disagree.
function describe(systems) {
  if (!systems.length) return ''
  const [timetable, learned] = systems
  const held = learned?.last?.trains.filter((t) => t.holding).length || 0
  if (held > 0) return 'this train is holding to let the gap behind close.'

  // An even seven trains sit at a third of the gap ahead of them. The runs put
  // the baseline's fifth percentile at 0.24 and the policy's at 0.29, so a
  // quarter and a bit is where the two actually part company: below it, twenty
  // percent of the timetable day and none of the learned one. Read at 0.18 it
  // fired on a handful of ticks in the whole run and the sentence never came
  // up at all.
  const tight = (sys) =>
    sys?.last?.trains.filter((t) => (t.obs?.headway_ahead_ratio ?? 1) < 0.26).length || 0
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
    const HOME = { yaw: 0, pitch: 0.24, dist: 15 }
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

    buildLights(scene)
    buildGround(scene)

    let raf = 0
    let disposed = false
    const clock = new THREE.Clock()
    // ?t=250 starts the clock partway through the day. Nothing in the product
    // reads it; it exists so a still can be taken of a named moment instead of
    // whatever moment a headless browser happened to stop on.
    let head = Number(new URLSearchParams(location.search).get('t')) || 0
    let narrate = 0
    const state = { systems: [] }

    const dummy = new THREE.Object3D()
    const COL = new THREE.Color()
    const AIM_PT = new THREE.Vector3()
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
      for (const d of docs) {
        buildTrack(group, d.stations, project)
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
        // Camera yaw, damped. Held per system because each side rides its own
        // train and the two are rarely at the same place on the line.
        camYaw: null,
        trains: buildTrains(group, trainCount),
        contacts: buildContacts(group, trainCount),
        riders: buildRiders(group, stationCount * RIDERS_PER_STATION),
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
      // its shot at all. The L is only about sixty units end to end, so the
      // nearest the two ever come is well past where the fog closes.
      const gap = 210
      state.systems = [
        buildSystem([left], project, 0, -gap / 2),
        buildSystem([right], project, 0, gap / 2),
      ]
      setReady(true)
    }

    const frame = () => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(0.05, clock.getDelta())

      if (state.systems.length) {
        if (playingRef.current) head += dt * TICKS_PER_SEC
        const n = state.systems[0].docs[0].ticks.length
        if (head >= n) head -= n

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

              // The train this side's camera rides. Its aim is a weighted mean
              // of where the line will be over the next several stations, not
              // where this segment points.
              if (tix === MOUNT_INDEX) {
                at(sys, s2, tr.pos, HERE)
                AIM_PT.set(0, 0, 0)
                for (const [d, wt] of AIM) {
                  AIM_PT.addScaledVector(at(sys, s2, tr.pos + d * tr.dir, LEAD), wt)
                }
                AIM_PT.sub(HERE)
                // Sitting on the buffers every sample lands on the terminal and
                // the mean collapses onto the train, which has no direction in
                // it. Hold the last heading until the train has a new one.
                if (AIM_PT.lengthSq() > 0.36) sys.aim = Math.atan2(AIM_PT.z, AIM_PT.x)
                // Riding the same way the train is on, not the centreline, so
                // the track under the camera is the track under the train.
                sys.mount = { x: HERE.x + WAY.x, y: 0.9, z: HERE.z + WAY.z }
              }
              ti++
            }

            for (let i = 0; i < s2.stations.length; i++) {
              const st = s2.stations[i]
              const w = sys.project(st.x, st.y)
              const show = Math.min(RIDERS_PER_STATION, Math.round((s2.waiting[i] || 0) / 6))
              for (let k = 0; k < RIDERS_PER_STATION; k++) {
                if (k < show) {
                  // Clear of the bed. Two ways make the permanent way four and
                  // a half units across, and the old ring put riders standing
                  // between the rails. Still a ring, still a placeholder: the
                  // platforms they belong on are the next piece of work.
                  const a = (k / RIDERS_PER_STATION) * Math.PI * 2 + i
                  dummy.position.set(w.x + Math.cos(a) * 3.4, 0.2, w.z + Math.sin(a) * 3.4)
                  dummy.scale.setScalar(1)
                } else {
                  dummy.position.set(0, -50, 0)
                  dummy.scale.setScalar(0.0001)
                }
                dummy.rotation.set(0, 0, 0)
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
        if (m && sys.aim != null) {
          // Trail the aim rather than take it. The whole shot is the track
          // receding, and a yaw that arrives at the new heading on the same
          // frame the train does turns every corner into a cut.
          const err = sys.camYaw == null ? 0 : wrapPi(sys.aim - sys.camYaw)
          // A turnaround is a cut, not a pan. Trailing through a hundred and
          // eighty degrees means watching your own train drive past the lens
          // for a second and a half, which reads as the camera coming loose.
          if (sys.camYaw == null || Math.abs(err) > 2.0) sys.camYaw = sys.aim
          else sys.camYaw += err * (1 - Math.exp(-dt * YAW_LAG))

          const fx = Math.cos(sys.camYaw)
          const fz = Math.sin(sys.camYaw)
          const back = orbit.dist * Math.cos(orbit.pitch)
          const up = orbit.dist * Math.sin(orbit.pitch) + 1.6
          // Dragging swings the mount point around the train; the camera goes
          // on looking down the line either way.
          const cy = Math.cos(orbit.yaw)
          const sy = Math.sin(orbit.yaw)
          const bx = -(fx * cy - fz * sy)
          const bz = -(fx * sy + fz * cy)
          cam.position.set(m.x + bx * back, m.y + up, m.z + bz * back)
          cam.lookAt(m.x + fx * 26, m.y + 1.3, m.z + fz * 26)
        }
        cam.aspect = halfW / H
        cam.updateProjectionMatrix()
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
