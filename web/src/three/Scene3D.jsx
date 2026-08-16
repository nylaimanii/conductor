import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'

import { loadRun, peekRun, FINAL_TAG } from '../runs.js'
import { sampleLine } from '../sample.js'
import { posToXY, boundsOf } from '../geometry.js'
import {
  SCALE,
  COLORS,
  makeProjector,
  buildLights,
  buildGround,
  buildTrack,
  buildTrains,
  buildContacts,
  buildRiders,
  buildLabel,
  buildCaption,
  buildPool,
} from './world.js'

// The scene. A physical world seen from outside, orbited freely.
//
// The screen carries nothing but the world and a play control: no numbers, no
// scrubber, no labels beyond a quiet letter per line. The simulation runs on
// its own clock and is never gated on the camera.

// Fast enough that the world streams. At a walking rate the scene reads as a
// progress bar rather than as travelling.
const TICKS_PER_SEC = 46
// Riders are deliberately sparse. A platform shows at most this many, with no
// count anywhere. The crowd is a texture, not a readout.
const RIDERS_PER_STATION = 4
// The line the policy was trained on, and the one the comparison runs.
const COMPARE_LINE = 'L'
// Both sides ride the same train index, so the two views stay comparable.
const MOUNT_INDEX = 0

export default function Scene3D({ playing }) {
  const hostRef = useRef(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(null)
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
    scene.fog = new THREE.Fog(COLORS.bg, 70, 320)

    // One camera per side. The comparison is two ride-alongs running in
    // lockstep, so each needs its own view mounted on its own train.
    const cams = [0, 1].map(() => {
      const c = new THREE.PerspectiveCamera(58, host.clientWidth / 2 / host.clientHeight, 0.3, 1200)
      return c
    })

    // Orbit is expressed relative to the mount rather than to a fixed target,
    // because the target is a train travelling down a line. OrbitControls
    // assumes a stationary centre and fights a moving one.
    const orbit = { yaw: 0, pitch: 0.3, dist: 22, tYaw: 0, tPitch: 0.3, tDist: 22 }
    const HOME = { yaw: 0, pitch: 0.3, dist: 22 }
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
    let head = 0
    const state = { systems: [] }

    const dummy = new THREE.Object3D()

    // A system is one running simulation: its own tracks, trains and riders,
    // offset along x so two can stand side by side in the same world.
    const buildSystem = (docs, project, offsetX, offsetZ, caption, yaw = 0) => {
      const group = new THREE.Group()
      group.position.x = offsetX
      group.position.z = offsetZ
      // Turned so the line lies across the frame. Left as a diagonal it cuts
      // corner to corner and leaves most of the screen as empty floor.
      group.rotation.y = yaw
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

      const sys = {
        docs,
        project,
        group,
        yaw,
        trains: buildTrains(group, trainCount),
        contacts: buildContacts(group, trainCount),
        riders: buildRiders(group, stationCount * RIDERS_PER_STATION),
      }

      // The one piece of text the comparison needs. Same quiet treatment as the
      // line letters: without it, two identical worlds side by side say nothing
      // about which is which.
      if (caption) {
        // Anchored to this line's own first station, inside the group, so the
        // yaw carries it with the line. Positioning it from unrotated bounds
        // put one system's caption over the other's track.
        const st = docs[0].stations[0]
        const p0 = project(st.x, st.y)
        buildCaption(group, caption, new THREE.Vector3(p0.x + 26, 0, p0.z))
      }
      return sys
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
      const b = boundsOf([right])
      const spanX = (b.maxX - b.minX) * SCALE
      const spanZ = (b.maxY - b.minY) * SCALE
      // Stacked along z rather than x: the L runs mostly east to west, so two
      // copies side by side would be twice as wide again and read as one long
      // smear. One in front of the other keeps both close to the camera.
      // The line's own axis, so it can be turned flat across the frame.
      const head0 = project(left.stations[0].x, left.stations[0].y)
      const tail0 = project(
        left.stations[left.stations.length - 1].x,
        left.stations[left.stations.length - 1].y
      )
      const yaw = Math.atan2(tail0.z - head0.z, tail0.x - head0.x)

      // Stacked, not side by side. Once each line runs the full width of the
      // frame the two cannot also sit beside each other, and full width per
      // line is what makes individual trains legible without zooming.
      const gap = 22
      state.systems = [
        buildSystem([left], project, 0, -gap / 2, "today's timetable", yaw),
        buildSystem([right], project, 0, gap / 2, 'after learning', yaw),
      ]
      buildPool(scene, 160)
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
            for (let tix = 0; tix < s2.trains.length; tix++) {
              const tr = s2.trains[tix]
              const p = posToXY(s2.stations, tr.pos)
              const ahead = posToXY(s2.stations, Math.min(s2.stations.length - 1, tr.pos + 0.4))
              const w = sys.project(p.x, p.y)
              const wa = sys.project(ahead.x, ahead.y)

              dummy.position.set(w.x, 0.24, w.z)
              dummy.rotation.set(0, -Math.atan2(wa.z - w.z, wa.x - w.x), 0)
              dummy.scale.setScalar(1)
              dummy.updateMatrix()
              sys.trains.setMatrixAt(ti, dummy.matrix)

              dummy.position.set(w.x, 0.045, w.z)
              dummy.rotation.set(0, 0, 0)
              dummy.updateMatrix()
              sys.contacts.setMatrixAt(ti, dummy.matrix)

              // The train this side's camera rides.
              if (tix === MOUNT_INDEX) {
                const dx = wa.x - w.x
                const dz = wa.z - w.z
                const len = Math.hypot(dx, dz) || 1
                sys.mount = {
                  pos: new THREE.Vector3(w.x + sys.group.position.x, 0.9, w.z + sys.group.position.z),
                  dir: new THREE.Vector3(dx / len, 0, dz / len),
                }
              }
              ti++
            }

            for (let i = 0; i < s2.stations.length; i++) {
              const st = s2.stations[i]
              const w = sys.project(st.x, st.y)
              const show = Math.min(RIDERS_PER_STATION, Math.round((s2.waiting[i] || 0) / 6))
              for (let k = 0; k < RIDERS_PER_STATION; k++) {
                if (k < show) {
                  const a = (k / RIDERS_PER_STATION) * Math.PI * 2 + i
                  dummy.position.set(w.x + Math.cos(a) * 1.15, 0.2, w.z + Math.sin(a) * 1.15)
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
          sys.contacts.instanceMatrix.needsUpdate = true
          sys.riders.instanceMatrix.needsUpdate = true
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
        if (m) {
          const fwd = m.dir
          const back = orbit.dist * Math.cos(orbit.pitch)
          const up = orbit.dist * Math.sin(orbit.pitch) + 1.6
          const cy = Math.cos(orbit.yaw)
          const sy = Math.sin(orbit.yaw)
          const bx = -(fwd.x * cy - fwd.z * sy)
          const bz = -(fwd.x * sy + fwd.z * cy)
          cam.position.set(m.pos.x + bx * back, m.pos.y + up, m.pos.z + bz * back)
          cam.lookAt(m.pos.x + fwd.x * 34, m.pos.y + 1.2, m.pos.z + fwd.z * 34)
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
      {failed && <div className="scene3d-fail mono">{failed}</div>}
      <button className="scene3d-reset mono" onClick={() => resetRef.current()}>
        reset view
      </button>
      <span className="scene3d-ready" data-ready={ready ? 'yes' : 'no'} />
    </div>
  )
}
