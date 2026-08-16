import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// The 3D world. A dark ground plane, the lines as physical raised tracks laid
// on it, and trains as simple lit volumes above them.
//
// Everything here is built once from the station geometry and then only the
// train transforms change per frame, so the per frame cost is a handful of
// matrix writes rather than any geometry work.

// World units per unit of sim coordinate space.
//
// At an eighth, the L's stations land 3.94 units apart — every one of its
// twenty three blocks the same length, and shorter than the train drawn on it.
// That was survivable from above and wrong from a cab: platforms ran into each
// other into one continuous colonnade, and a train permanently filled the
// block it was in, so every pair of trains looked bunched whether they were or
// not. At a fifth a block is 6.3 units, platforms stand apart, and the lit
// stations become things you can count down the line — which is what actually
// carries the argument, since the gap ahead differs between the two runs by
// about four blocks against six.
export const SCALE = 1 / 5

// Monochrome. No line colours anywhere: they read as a kids diagram and fight
// the look. Lines are told apart by a quiet letter at each terminal instead.
export const COLORS = {
  bg: 0x07080a,
  ground: 0x161b20,
  // Tracks are lit surfaces, not signs: desaturated, dim, and well below the
  // trains in brightness so nothing on the plane competes with them.
  track: 0x333c44,
  station: 0x4d5862,
  trainBody: 0xeef4f8,
  trainEmissive: 0x161c21,
  rider: 0x46545f,
  label: 'rgba(190,205,218,0.72)',
}

// Maps sim space to world space, centred on the network.
export function makeProjector(bounds) {
  const cx = (bounds.minX + bounds.maxX) / 2
  const cy = (bounds.minY + bounds.maxY) / 2
  return (x, y) => new THREE.Vector3((x - cx) * SCALE, 0, (y - cy) * SCALE)
}

// Stand the key light over a given point on the plane, keeping its direction
// fixed. Called once per viewport, just before that viewport renders.
export function aimKey(key, x, z) {
  key.position.set(x + 70, 120, z + 50)
  key.target.position.set(x, 0, z)
  key.target.updateMatrixWorld()
}

export function buildLights(scene) {
  // Very low ambient: the scene is near black and the trains carry the light.
  scene.add(new THREE.AmbientLight(0x3a444d, 0.3))

  // Key, from high and to one side, casting the soft shadows onto the plane.
  const key = new THREE.DirectionalLight(0xdfeaf5, 1.9)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.camera.near = 1
  key.shadow.camera.far = 400
  // Sized for one system, not for both. The renderer redraws the shadow map on
  // every render call and there are two of them per frame, one per viewport,
  // so the light can be walked over to whichever line is being rendered and
  // the frustum only ever has to cover that one. A box wide enough to hold
  // both spends its whole depth map on the empty ground between them.
  key.shadow.camera.left = -80
  key.shadow.camera.right = 80
  key.shadow.camera.top = 105
  key.shadow.camera.bottom = -105
  key.shadow.bias = -0.0012
  key.shadow.radius = 4
  scene.add(key)
  // The target has to be in the scene for its world matrix to be updated.
  scene.add(key.target)
  aimKey(key, 0, 0)

  // Rim, from low and behind, cool and dim. This is what gives the volumes an
  // edge against the dark rather than dissolving into it.
  const rim = new THREE.DirectionalLight(0x8fb0c8, 0.75)
  rim.position.set(-50, 14, -45)
  scene.add(rim)

  // A faint sky/ground bounce so the tops of things are not flat.
  scene.add(new THREE.HemisphereLight(0x3d4c5c, 0x07090b, 0.25))

  return key
}

function gridTexture() {
  const S = 256
  const c = document.createElement('canvas')
  c.width = S
  c.height = S
  const g = c.getContext('2d')
  // All but black. The ground is the thing light does not reach: at a ride
  // along height a lit floor fills half the frame and flattens everything on
  // it, and the trains and rails stop being the brightest objects in the shot.
  g.fillStyle = '#08090b'
  g.fillRect(0, 0, S, S)
  // Barely there. Dark grey on near black: enough to read the plane receding,
  // not enough to read as a chart.
  g.strokeStyle = 'rgba(150,185,215,0.055)'
  g.lineWidth = 1
  g.beginPath()
  g.moveTo(0.5, 0)
  g.lineTo(0.5, S)
  g.moveTo(0, 0.5)
  g.lineTo(S, 0.5)
  g.stroke()
  const tex = new THREE.CanvasTexture(c)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(190, 190)
  tex.anisotropy = 8
  return tex
}

// There used to be a soft radial pool of light on the plane here, one per
// system, brightest at the middle of the line and gone by the ends. It gave
// the plane a centre for the old overhead survey shot. From a cab it is a
// brightness gradient laid across the world with nothing physical behind it,
// and because each side rides a different train the two cameras sit at
// different distances from their own pool — so the two viewports read as
// differently exposed when the exposure, the fog and the ground are in fact
// all shared and identical. It was the only per-system thing in the lighting.

export function buildGround(scene) {
  const geo = new THREE.PlaneGeometry(1400, 1400)
  const mat = new THREE.MeshStandardMaterial({
    map: gridTexture(),
    // Multiplied down again on top of the near black map, so even the key
    // light's pool on the plane stays below the ballast.
    color: 0x8f9498,
    roughness: 0.95,
    metalness: 0.0,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.rotation.x = -Math.PI / 2
  mesh.position.y = -0.02
  mesh.receiveShadow = true
  scene.add(mesh)
  return mesh
}

// One line becomes a strip of thin boxes following its polyline, raised just
// off the plane. Boxes rather than a tube because the result reads as a laid
// track, and because a flat top face catches the key light cleanly.
// A real permanent way rather than a stroke: a ballast bed, two rails that
// catch the light, and ties at a regular interval. The ties are the point.
// Streaming underneath at speed they are what sells motion, the way lane
// markings do in the reference, and no amount of camera work substitutes.
// Half the distance between the two ways. A line is run out and back over one
// polyline in the run files, so on a single centreline a train going one way
// and a train coming the other pass through each other. From an overhead
// survey that was a smudge; from a cab it is the shot falling apart. Two ways
// costs one more pair of rails and fixes it, and gives the ride along the
// thing that most says moving: something going the other way, close.
export const WAY_OFFSET = 1.6

// Which way a train sits, given the direction it is heading. Left hand of
// travel, consistently, so the two ways never cross.
export function wayOffset(hx, hz, out) {
  return out.set(-hz * WAY_OFFSET, 0, hx * WAY_OFFSET)
}

export function buildTrack(scene, stations, project) {
  const group = new THREE.Group()

  const GAUGE = 1.05
  const TIE_EVERY = 1.5
  const BED = WAY_OFFSET * 2 + GAUGE + 0.9

  const ballastMat = new THREE.MeshStandardMaterial({
    color: 0x242c33,
    roughness: 1.0,
    metalness: 0.0,
  })
  // Metal, but not fully: with no environment to reflect, metalness near one
  // renders as black except where a highlight happens to land, and against a
  // near black ground the rails simply vanish. Half metal keeps a diffuse
  // component, so the ways read as two bright lines running to the horizon.
  //
  // The emissive is the floor under that. A rail's brightness otherwise
  // depends entirely on how the key light happens to rake it, which changes
  // with the direction the line is running — so the same rails read bright on
  // one heading and disappear on another, and with two cameras on different
  // parts of the line that looks like the two sides being lit differently. The
  // rails are the perspective line the whole shot is built on; they are not
  // allowed to depend on the compass.
  const railMat = new THREE.MeshStandardMaterial({
    color: 0xc6d6e2,
    roughness: 0.25,
    metalness: 0.35,
    emissive: 0x33424f,
    emissiveIntensity: 0.6,
  })
  const tieMat = new THREE.MeshStandardMaterial({
    color: 0x2e363d,
    roughness: 0.95,
    metalness: 0.0,
  })

  // Count ties first so they can share one instanced draw.
  const segs = []
  let tieTotal = 0
  for (let i = 0; i < stations.length - 1; i++) {
    const a = project(stations[i].x, stations[i].y)
    const b = project(stations[i + 1].x, stations[i + 1].y)
    const len = a.distanceTo(b)
    if (len < 1e-6) continue
    const n = Math.max(1, Math.floor(len / TIE_EVERY))
    segs.push({ a, b, len, n })
    tieTotal += n
  }

  const tieGeo = new THREE.BoxGeometry(0.34, 0.1, BED - 0.5)
  const ties = new THREE.InstancedMesh(tieGeo, tieMat, Math.max(1, tieTotal))
  ties.receiveShadow = true
  const dummy = new THREE.Object3D()
  let ti = 0

  for (const seg of segs) {
    const { a, b, len, n } = seg
    const yaw = -Math.atan2(b.z - a.z, b.x - a.x)
    const mid = a.clone().add(b).multiplyScalar(0.5)

    // Ballast: a low wide bed the track sits on.
    const bal = new THREE.Mesh(new THREE.BoxGeometry(len + 0.4, 0.1, BED), ballastMat)
    bal.position.set(mid.x, 0.07, mid.z)
    bal.rotation.y = yaw
    bal.receiveShadow = true
    group.add(bal)

    // Four rails, two ways, raised above the ties, metallic so they pick up a
    // highlight and read as the brightest thing on the plane after the trains.
    for (const way of [-1, 1]) {
      for (const side of [-1, 1]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(len + 0.6, 0.11, 0.13), railMat)
        const off = way * WAY_OFFSET + side * (GAUGE / 2)
        rail.position.set(mid.x + Math.sin(yaw) * off, 0.245, mid.z + Math.cos(yaw) * off)
        rail.rotation.y = yaw
        rail.castShadow = false
        rail.receiveShadow = true
        group.add(rail)
      }
    }

    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n
      dummy.position.set(a.x + (b.x - a.x) * t, 0.185, a.z + (b.z - a.z) * t)
      dummy.rotation.set(0, yaw, 0)
      dummy.scale.setScalar(1)
      dummy.updateMatrix()
      ties.setMatrixAt(ti++, dummy.matrix)
    }
  }
  ties.count = ti
  ties.instanceMatrix.needsUpdate = true
  group.add(ties)

  scene.add(group)
  return group
}

// Trains as one instanced mesh. A rounded-ish body: a box is enough at this
// scale, and the rim light does the shaping.
export function buildTrains(scene, count) {
  // Rounded on every edge. A hard box reads as programmer art at this scale,
  // and since the trains are the only bright thing in the frame their
  // silhouette is doing most of the work. Segments kept low: the bevel only
  // has to catch the rim light, not survive a close inspection.
  //
  // Two fifths of a block long. It used to be a whole block, sized so that a
  // pair of them touching read as bunching from across the room, but from a
  // cab that reads as bunching whether or not there is any: a train that fills
  // its block is never more than a block from looking joined to the next one.
  // A real train is about a fifth of the distance between two stops on the L.
  const geo = new RoundedBoxGeometry(2.6, 1.2, 1.7, 5, 0.34)
  geo.translate(0, 0.9, 0)
  const mat = new THREE.MeshStandardMaterial({
    color: COLORS.trainBody,
    emissive: COLORS.trainEmissive,
    emissiveIntensity: 0.35,
    roughness: 0.35,
    metalness: 0.25,
  })
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, count))
  // Per instance colour: a train that has closed on the one ahead dims and
  // warms. The object is the readout, so there is no label anywhere.
  mesh.instanceColor = new THREE.InstancedBufferAttribute(
    new Float32Array(Math.max(1, count) * 3).fill(1),
    3
  )
  mesh.castShadow = true
  mesh.receiveShadow = false
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.frustumCulled = false
  scene.add(mesh)
  return mesh
}

// The trains on the other way, going the other way.
//
// These were the same bright volumes as the ones being followed, and at any
// distance a train on the second way is indistinguishable from a train ahead
// on yours — so the learned side, whose whole point is open track in front,
// read as bunched every time something passed the other way. That attacks the
// argument directly, and it is an artefact of drawing two ways rather than
// anything either policy did.
//
// Unlit on purpose: a basic material takes no key light, no rim, and no
// specular, so an oncoming train is a flat dark silhouette that fogs out with
// distance. It is traffic, not a subject. It still takes the fog, so it sits
// in the same air as everything else.
export function buildOncoming(scene, count) {
  const geo = new RoundedBoxGeometry(2.6, 1.2, 1.7, 5, 0.34)
  geo.translate(0, 0.9, 0)
  const mat = new THREE.MeshBasicMaterial({ color: 0x1d242a, fog: true })
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, count))
  mesh.castShadow = false
  mesh.receiveShadow = false
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.frustumCulled = false
  scene.add(mesh)
  return mesh
}

// A cheap contact shadow: a dark disc under each train, so a volume reads as
// sitting on the plane rather than floating over it. Costs one instanced draw
// and does not depend on the shadow map resolution.
export function buildContacts(scene, count) {
  const geo = new THREE.CircleGeometry(1.5, 20)
  geo.rotateX(-Math.PI / 2)
  const mat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.38,
    depthWrite: false,
  })
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, count))
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.frustumCulled = false
  mesh.renderOrder = 1
  scene.add(mesh)
  return mesh
}

// Riders: a body and a head, merged so a platform full of them costs one draw.
// Small, dark and quiet. The crowd is a texture, never a count.
export function buildRiders(scene, count) {
  const body = new RoundedBoxGeometry(0.26, 0.56, 0.2, 2, 0.07)
  body.translate(0, 0.28, 0)
  // Non-indexed to match the body: RoundedBoxGeometry unindexes itself, and
  // mergeGeometries refuses a mix and hands back null rather than throwing, so
  // the failure surfaces as a black frame much later.
  const head = new THREE.SphereGeometry(0.11, 8, 6).toNonIndexed()
  head.translate(0, 0.67, 0)
  const geo = mergeGeometries([body, head])
  const mat = new THREE.MeshStandardMaterial({
    color: COLORS.rider,
    roughness: 0.9,
    metalness: 0.0,
  })
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, count))
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.castShadow = true
  mesh.frustumCulled = false
  return mesh && scene.add(mesh), mesh
}


// The heading of the line at a station, as a unit vector in world space.
// Averaged across the joint, so a platform at a corner sits square to the
// bisector rather than to whichever segment happened to be asked for.
function headingAt(pts, i) {
  const a = pts[Math.max(0, i - 1)]
  const b = pts[Math.min(pts.length - 1, i + 1)]
  const dx = b.x - a.x
  const dz = b.z - a.z
  const len = Math.hypot(dx, dz) || 1
  return [dx / len, dz / len]
}

// Shorter than a block, so platforms stand apart as separate places instead of
// running into one another down the whole line.
const PLAT_LEN = 4.6
const PLAT_W = 2.8
const PLAT_H = 0.5
// Inner edge, clear of the ballast and of a train's flank. Derived from the
// way spacing rather than written down, so widening the ways cannot quietly
// leave the platforms standing inside the trains.
const PLAT_IN = WAY_OFFSET + 1.15
const PLAT_MID = PLAT_IN + PLAT_W / 2
const CANOPY_Y = 2.9

// Stations as places rather than dots: a platform down each side of the two
// ways, a canopy over each on two columns, and a lit strip under the canopy.
// The strip is the point. In a scene where nothing else emits, a station
// becomes a pool of light the ride approaches, passes through and leaves, and
// that is what makes a station an event rather than a marker.
//
// Everything is instanced by part, so twenty four stations are five draws.
export function buildStations(scene, stations, project) {
  const n = stations.length
  const pts = stations.map((s) => project(s.x, s.y))

  // Same reasoning as the massing: platforms are big surfaces passing close to
  // the camera, so lighting them makes the frame's value depend on whether a
  // station happens to be alongside. Dark concrete, and the strip does the
  // work of saying a station is there.
  const concrete = new THREE.MeshStandardMaterial({
    color: 0x1c2229,
    roughness: 0.95,
    metalness: 0.0,
  })
  const canopyMat = new THREE.MeshStandardMaterial({
    color: 0x0f1317,
    roughness: 0.9,
    metalness: 0.0,
  })
  // Emissive only. Adding forty eight real lights to light forty eight
  // platforms is not a trade worth making; the strip reads as the source and
  // the glow below stands in for its spill.
  const stripMat = new THREE.MeshStandardMaterial({
    color: 0x000000,
    emissive: 0xbcd4e6,
    emissiveIntensity: 1.5,
    roughness: 1.0,
  })
  const spillMat = new THREE.MeshBasicMaterial({
    color: 0x7f9db8,
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })

  const sides = n * 2
  const mk = (geo, mat, count, shadow) => {
    const m = new THREE.InstancedMesh(geo, mat, count)
    m.receiveShadow = !!shadow
    m.castShadow = !!shadow
    scene.add(m)
    return m
  }

  const slab = mk(new THREE.BoxGeometry(PLAT_LEN, PLAT_H, PLAT_W), concrete, sides, true)
  const canopy = mk(
    new THREE.BoxGeometry(PLAT_LEN, 0.14, PLAT_W + 0.4),
    canopyMat,
    sides,
    true
  )
  const column = mk(new THREE.BoxGeometry(0.18, CANOPY_Y - PLAT_H, 0.18), concrete, sides * 2, true)
  const strip = mk(new THREE.BoxGeometry(PLAT_LEN - 0.8, 0.07, 0.22), stripMat, sides, false)
  const spillGeo = new THREE.PlaneGeometry(PLAT_LEN, PLAT_W)
  spillGeo.rotateX(-Math.PI / 2)
  const spill = mk(spillGeo, spillMat, sides, false)
  spill.renderOrder = 2

  const d = new THREE.Object3D()
  let si = 0
  let ci = 0
  // Where a rider can stand, worked out once. Per frame the scene only decides
  // how many of these are occupied.
  const slots = []

  for (let i = 0; i < n; i++) {
    const p = pts[i]
    const [hx, hz] = headingAt(pts, i)
    const yaw = -Math.atan2(hz, hx)
    // Left hand normal of the heading, the same convention the ways use.
    const nx = -hz
    const nz = hx

    for (const side of [-1, 1]) {
      const cx = p.x + nx * side * PLAT_MID
      const cz = p.z + nz * side * PLAT_MID

      d.rotation.set(0, yaw, 0)
      d.scale.setScalar(1)

      d.position.set(cx, PLAT_H / 2, cz)
      d.updateMatrix()
      slab.setMatrixAt(si, d.matrix)

      d.position.set(cx, CANOPY_Y, cz)
      d.updateMatrix()
      canopy.setMatrixAt(si, d.matrix)

      d.position.set(cx, CANOPY_Y - 0.12, cz)
      d.updateMatrix()
      strip.setMatrixAt(si, d.matrix)

      d.position.set(cx, PLAT_H + 0.012, cz)
      d.updateMatrix()
      spill.setMatrixAt(si, d.matrix)

      // Two columns, set in from the platform ends and standing on its outer
      // edge so nothing blocks the view along the train.
      for (const end of [-1, 1]) {
        const ox = hx * end * (PLAT_LEN / 2 - 0.7) + nx * side * (PLAT_W / 2 - 0.3)
        const oz = hz * end * (PLAT_LEN / 2 - 0.7) + nz * side * (PLAT_W / 2 - 0.3)
        d.position.set(cx + ox, PLAT_H + (CANOPY_Y - PLAT_H) / 2, cz + oz)
        d.updateMatrix()
        column.setMatrixAt(ci++, d.matrix)
      }

      // Riders queue along the platform, a little back from the edge, facing
      // the track they are waiting for.
      for (let k = 0; k < RIDER_SLOTS_PER_SIDE; k++) {
        const along = (k / (RIDER_SLOTS_PER_SIDE - 1) - 0.5) * (PLAT_LEN - 1.6)
        const jitter = (((i * 7 + k * 13 + (side + 1) * 5) % 9) / 9 - 0.5) * 0.7
        const back = 0.35 + (((i * 3 + k * 5) % 5) / 5) * 0.5
        slots.push({
          x: cx + hx * (along + jitter) - nx * side * back,
          z: cz + hz * (along + jitter) - nz * side * back,
          // Facing across to the platform edge.
          yaw: -Math.atan2(-nz * side, -nx * side),
        })
      }
      si++
    }
  }

  for (const m of [slab, canopy, column, strip, spill]) m.instanceMatrix.needsUpdate = true
  return slots
}

// Riders per platform side, so eight standing places at a station. The cap is
// what keeps a crowd a texture: a platform that is full looks full, and there
// is never a number to read off it.
export const RIDER_SLOTS_PER_SIDE = 4
export const RIDER_SLOTS_PER_STATION = RIDER_SLOTS_PER_SIDE * 2

// Dark massing along the sides of the line. Not buildings: blocks, unlit
// except for what the sky bounce gives them, there so the ride has a world at
// its edges instead of a void above the horizon. Deterministic, because both
// systems have to stand in the same city for the comparison to be about the
// trains.
export function buildMassing(scene, stations, project) {
  const pts = stations.map((s) => project(s.x, s.y))

  // A hash rather than a random: reloading must not redraw the skyline, and
  // the two systems must get the same one.
  const rand = (n) => {
    const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
    return x - Math.floor(x)
  }

  // Squared distance from a point to a segment, on the plane.
  const distToSeg = (px, pz, a, b) => {
    const vx = b.x - a.x
    const vz = b.z - a.z
    const wx = px - a.x
    const wz = pz - a.z
    const vv = vx * vx + vz * vz
    const t = vv > 1e-9 ? Math.max(0, Math.min(1, (wx * vx + wz * vz) / vv)) : 0
    const dx = wx - vx * t
    const dz = wz - vz * t
    return Math.hypot(dx, dz)
  }

  // Clear of every part of the line, not just the segment a block was placed
  // from. The L doubles back on itself: stations 13 and 16 pass within
  // eighteen units of each other, well inside the band these are scattered
  // through, so blocks placed out to the side of one stretch were landing on
  // top of another. A camera riding that stretch then runs straight through
  // the inside of a building, which renders as a viewport that has simply gone
  // black with nothing in the console to say why.
  const clearOfLine = (x, z, margin) => {
    for (let i = 0; i < pts.length - 1; i++) {
      if (distToSeg(x, z, pts[i], pts[i + 1]) < margin) return false
    }
    return true
  }

  const boxes = []
  let dropped = 0
  let seed = 0
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const len = Math.hypot(b.x - a.x, b.z - a.z)
    if (len < 1e-6) continue
    const hx = (b.x - a.x) / len
    const hz = (b.z - a.z) / len
    const nx = -hz
    const nz = hx

    for (let t = 1.2; t < len; t += 2.4 + rand(seed++) * 2.2) {
      for (const side of [-1, 1]) {
        for (const row of [0, 1]) {
          seed++
          if (rand(seed) < 0.28) continue
          const out = 9 + row * 9 + rand(seed + 1) * 6
          const w = 2.4 + rand(seed + 2) * 4.5
          const dpt = 2.4 + rand(seed + 3) * 4.5
          const h = 3 + rand(seed + 4) ** 2.2 * 22
          const bx = a.x + hx * t + nx * side * out
          const bz = a.z + hz * t + nz * side * out
          // Its own footprint plus the platforms plus a street.
          if (!clearOfLine(bx, bz, 6.5 + Math.max(w, dpt) / 2)) {
            dropped++
            continue
          }
          boxes.push({
            x: bx,
            z: bz,
            w,
            d: dpt,
            h,
            yaw: -Math.atan2(hz, hx) + (rand(seed + 5) - 0.5) * 0.5,
          })
        }
      }
    }
  }

  const geo = new THREE.BoxGeometry(1, 1, 1)
  geo.translate(0, 0.5, 0)
  // Nearly silhouette. Buildings are the largest lit surface in any frame and
  // the one whose amount changes most as the camera moves, so how bright they
  // are decides how much the frame's overall value swings with position. The
  // two viewports ride different trains and are therefore always in different
  // parts of the city; with the blocks lit, the denser side reads as a
  // brighter exposure than the emptier one, which looks like the two sides
  // being graded differently when the lighting is in fact identical. Dark
  // enough and the city is a skyline instead of a light source.
  const mat = new THREE.MeshStandardMaterial({
    color: 0x090b0e,
    roughness: 1.0,
    metalness: 0.0,
  })
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, boxes.length))
  const d = new THREE.Object3D()
  boxes.forEach((b, i) => {
    d.position.set(b.x, 0, b.z)
    d.rotation.set(0, b.yaw, 0)
    d.scale.set(b.w, b.h, b.d)
    d.updateMatrix()
    mesh.setMatrixAt(i, d.matrix)
  })
  mesh.instanceMatrix.needsUpdate = true
  mesh.castShadow = false
  mesh.receiveShadow = true
  scene.add(mesh)
  return mesh
}

// A quiet letter identifying a line, drawn into a texture and hung as a sprite
// so it always faces the camera and stays legible from any orbit angle. This
// replaces the line colours: the only identification in the scene.
export function buildLabel(scene, text, position) {
  const size = 128
  const c = document.createElement('canvas')
  c.width = size
  c.height = size
  const g = c.getContext('2d')
  g.clearRect(0, 0, size, size)
  g.font = '600 62px "JetBrains Mono", ui-monospace, monospace'
  g.fillStyle = COLORS.label
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(text, size / 2, size / 2 + 2)

  const tex = new THREE.CanvasTexture(c)
  tex.anisotropy = 4
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    // Slightly translucent so a label never reads as brighter than a train.
    opacity: 0.85,
  })
  const sprite = new THREE.Sprite(mat)
  sprite.position.copy(position)
  sprite.position.y = 3.4
  sprite.scale.set(2.1, 2.1, 1)
  scene.add(sprite)
  return sprite
}

// The two captions used to be sprites hung in the world. From a ride along
// camera a sprite parked next to a terminal is off screen almost always, and
// when it is on screen it is somewhere different in each viewport. They live
// in the DOM now, one per viewport, anchored to the screen.
