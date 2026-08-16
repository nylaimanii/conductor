import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { LINE_IDS, loadRun, peekRun, FINAL_TAG } from '../runs.js'
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
} from './world.js'

// The scene. A physical world seen from outside, orbited freely.
//
// The screen carries nothing but the world and a play control: no numbers, no
// scrubber, no labels beyond a quiet letter per line. The simulation runs on
// its own clock and is never gated on the camera.

const TICKS_PER_SEC = 12
// Riders are deliberately sparse. A platform shows at most this many, with no
// count anywhere. The crowd is a texture, not a readout.
const RIDERS_PER_STATION = 4

export default function Scene3D({ playing, mode = 'single' }) {
  const hostRef = useRef(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(null)
  const playingRef = useRef(playing)
  playingRef.current = playing
  const modeRef = useRef(mode)
  modeRef.current = mode
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

    const camera = new THREE.PerspectiveCamera(45, host.clientWidth / host.clientHeight, 0.5, 1200)
    camera.position.set(42, 34, 54)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.07
    controls.rotateSpeed = 0.55
    controls.zoomSpeed = 0.85
    controls.panSpeed = 0.6
    // Full turn horizontally; vertically from just above ground to top down.
    controls.minPolarAngle = 0.02
    controls.maxPolarAngle = Math.PI / 2 - 0.03
    controls.minDistance = 6
    controls.maxDistance = 260
    controls.target.set(0, 0, 0)

    const home = { pos: camera.position.clone(), target: controls.target.clone() }
    resetRef.current = () => {
      camera.position.copy(home.pos)
      controls.target.copy(home.target)
      controls.update()
    }

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
    const buildSystem = (docs, project, offsetX, caption) => {
      const group = new THREE.Group()
      group.position.x = offsetX
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
        trains: buildTrains(group, trainCount),
        contacts: buildContacts(group, trainCount),
        riders: buildRiders(group, stationCount * RIDERS_PER_STATION),
      }

      // The one piece of text the comparison needs. Same quiet treatment as the
      // line letters: without it, two identical worlds side by side say nothing
      // about which is which.
      if (caption) {
        const box = new THREE.Box3()
        for (const d of docs) for (const st of d.stations) box.expandByPoint(project(st.x, st.y))
        const c = box.getCenter(new THREE.Vector3())
        buildCaption(group, caption, new THREE.Vector3(c.x, 0, box.min.z - 6))
      }
      return sys
    }

    const frameOn = (systems) => {
      const box = new THREE.Box3()
      for (const sys of systems) {
        for (const d of sys.docs) {
          for (const st of d.stations) {
            const p = sys.project(st.x, st.y)
            box.expandByPoint(new THREE.Vector3(p.x + sys.group.position.x, 0, p.z))
          }
        }
      }
      const size = box.getSize(new THREE.Vector3())
      const centre = box.getCenter(new THREE.Vector3())
      const span = Math.max(size.x, size.z)
      controls.target.copy(centre)
      camera.position.set(centre.x + span * 0.10, span * 0.30, centre.z + span * 0.46)
      controls.update()
      home.pos.copy(camera.position)
      home.target.copy(controls.target)
    }

    const build = () => {
      if (modeRef.current === 'compare') {
        const left = LINE_IDS.map((l) => peekRun(l, 'baseline')).filter(Boolean)
        const right = LINE_IDS.map((l) => peekRun(l, FINAL_TAG)).filter(Boolean)
        if (!left.length || !right.length) return
        const project = makeProjector(boundsOf(right))
        const width = boundsOf(right)
        const spanX = (width.maxX - width.minX) * SCALE
        const gap = spanX * 0.07
        state.systems = [
          buildSystem(left, project, -(spanX + gap) / 2, "today's timetable"),
          buildSystem(right, project, (spanX + gap) / 2, 'after learning'),
        ]
      } else {
        const docs = LINE_IDS.map((l) => peekRun(l, FINAL_TAG)).filter(Boolean)
        if (!docs.length) return
        state.systems = [buildSystem(docs, makeProjector(boundsOf(docs)), 0, null)]
      }
      frameOn(state.systems)
      setReady(true)
    }

    const frame = () => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(0.05, clock.getDelta())
      controls.update()

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
            for (const tr of s2.trains) {
              const p = posToXY(s2.stations, tr.pos)
              const ahead = posToXY(s2.stations, Math.min(s2.stations.length - 1, tr.pos + 0.05))
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

      renderer.render(scene, camera)
    }

    const resize = () => {
      if (!host.clientWidth) return
      camera.aspect = host.clientWidth / host.clientHeight
      camera.updateProjectionMatrix()
      renderer.setSize(host.clientWidth, host.clientHeight)
    }
    const ro = new ResizeObserver(resize)
    ro.observe(host)

    // Only the trained runs, one tag, loaded once.
    const need = mode === 'compare' ? ['baseline', FINAL_TAG] : [FINAL_TAG]
    Promise.all(
      need.flatMap((tag) =>
        LINE_IDS.map((l) => (peekRun(l, tag) ? Promise.resolve() : loadRun(l, tag).catch(() => {})))
      )
    ).then(() => {
      if (!disposed) build()
    })

    raf = requestAnimationFrame(frame)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
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
  }, [mode])

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
