import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'

// The 3D world. A dark ground plane, the lines as physical raised tracks laid
// on it, and trains as simple lit volumes above them.
//
// Everything here is built once from the station geometry and then only the
// train transforms change per frame, so the per frame cost is a handful of
// matrix writes rather than any geometry work.

// World units per unit of sim coordinate space. The network spans roughly
// 910 x 530 in sim space, so this puts it at about 114 x 66 units across.
export const SCALE = 1 / 8

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

export function buildLights(scene) {
  // Very low ambient: the scene is near black and the trains carry the light.
  scene.add(new THREE.AmbientLight(0x3a444d, 0.3))

  // Key, from high and to one side, casting the soft shadows onto the plane.
  const key = new THREE.DirectionalLight(0xdfeaf5, 1.9)
  key.position.set(70, 120, 50)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.camera.near = 1
  key.shadow.camera.far = 520
  // Wide enough to hold both systems at once. They stand far enough apart that
  // neither is ever in the other's shot, and a frustum sized for one of them
  // leaves the other with no shadows at all. Kept as tight as that separation
  // allows, because every unit of slack here is spent out of the depth map.
  key.shadow.camera.left = -50
  key.shadow.camera.right = 50
  key.shadow.camera.top = 155
  key.shadow.camera.bottom = -155
  key.shadow.bias = -0.0012
  key.shadow.radius = 4
  scene.add(key)

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

// A soft pool of light under the scene, so the plane has a centre and falls
// off rather than reading as an evenly lit sheet that simply stops.
function poolTexture() {
  const S = 512
  const c = document.createElement('canvas')
  c.width = S
  c.height = S
  const g = c.getContext('2d')
  const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2)
  grad.addColorStop(0, 'rgba(120,165,205,0.035)')
  grad.addColorStop(0.45, 'rgba(90,130,170,0.015)')
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, S, S)
  return new THREE.CanvasTexture(c)
}

export function buildPool(scene, radius) {
  const geo = new THREE.PlaneGeometry(radius * 2, radius * 2)
  geo.rotateX(-Math.PI / 2)
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({
      map: poolTexture(),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  )
  mesh.position.y = 0.005
  mesh.renderOrder = -1
  scene.add(mesh)
  return mesh
}

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
export const WAY_OFFSET = 1.3

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
  const railMat = new THREE.MeshStandardMaterial({
    color: 0xb4c6d4,
    roughness: 0.28,
    metalness: 0.45,
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
  // The vehicles are the subject, not details on a line. Sized so a train is
  // roughly five times the width of the track it sits on and most of the gap
  // between two stations, which is what makes a pair of them touching read as
  // bunching from across the room.
  const geo = new RoundedBoxGeometry(4.0, 1.35, 1.9, 5, 0.4)
  geo.translate(0, 0.98, 0)
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

// A cheap contact shadow: a dark disc under each train, so a volume reads as
// sitting on the plane rather than floating over it. Costs one instanced draw
// and does not depend on the shadow map resolution.
export function buildContacts(scene, count) {
  const geo = new THREE.CircleGeometry(2.3, 20)
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

// Riders: small quiet volumes beside a platform. Sparse on purpose, capped
// low, no labels. If in doubt there are fewer of them.
export function buildRiders(scene, count) {
  const geo = new RoundedBoxGeometry(0.3, 0.8, 0.3, 2, 0.1)
  geo.translate(0, 0.4, 0)
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
