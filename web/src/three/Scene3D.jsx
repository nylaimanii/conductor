import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
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
// The line the policy was trained on, and the one the comparison runs.
const COMPARE_LINE = 'L'

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
    const buildSystem = (docs, project, offsetX, offsetZ, caption) => {
      const group = new THREE.Group()
      group.position.x = offsetX
      group.position.z = offsetZ
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
        buildCaption(group, caption, new THREE.Vector3(c.x, 0, box.min.z - 5))
      }
      return sys
    }

    const frameOn = (systems) => {
      const box = new THREE.Box3()
      for (const sys of systems) {
        for (const d of sys.docs) {
          for (const st of d.stations) {
            const p = sys.project(st.x, st.y)
            box.expandByPoint(
              new THREE.Vector3(p.x + sys.group.position.x, 0, p.z + sys.group.position.z)
            )
          }
        }
      }
      const sphere = box.getBoundingSphere(new THREE.Sphere())
      const centre = sphere.center.clone()
      centre.y = 0

      // Fit the bounding sphere, not the box. The line runs diagonally, so a
      // box fit depends on which way the scene happens to be oriented and
      // pushed half of it off screen. A sphere does not care.
      const vFov = (camera.fov * Math.PI) / 180
      const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect)
      // Deliberately inside a true sphere fit. Fitting the sphere exactly
      // leaves the scene small in frame, because the sphere of two diagonal
      // lines is much larger than what they actually occupy on screen. This
      // crops the empty corners and gets the camera close.
      const dist = (sphere.radius / Math.sin(Math.min(vFov, hFov) / 2)) * 0.72
      const elevation = 0.66

      controls.target.copy(centre)
      camera.position.set(
        centre.x,
        Math.sin(elevation) * dist,
        centre.z + Math.cos(elevation) * dist
      )
      controls.update()
      home.pos.copy(camera.position)
      home.target.copy(controls.target)
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
      // Left and right, as a comparison should read.
      const gap = Math.max(spanX * 0.12, 8)
      state.systems = [
        buildSystem([left], project, -(spanX + gap) / 2, 0, "today's timetable"),
        buildSystem([right], project, (spanX + gap) / 2, 0, 'after learning'),
      ]
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
