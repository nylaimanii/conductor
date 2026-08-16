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
  trainBody: 0xdde6ee,
  trainEmissive: 0x2a3a45,
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
  scene.add(new THREE.AmbientLight(0x2c3d4c, 0.42))

  // Key, from high and to one side, casting the soft shadows onto the plane.
  const key = new THREE.DirectionalLight(0xdfeaf5, 1.9)
  key.position.set(40, 70, 30)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.camera.near = 1
  key.shadow.camera.far = 260
  const s = 90
  key.shadow.camera.left = -s
  key.shadow.camera.right = s
  key.shadow.camera.top = s
  key.shadow.camera.bottom = -s
  key.shadow.bias = -0.0012
  key.shadow.radius = 4
  scene.add(key)

  // Rim, from low and behind, cool and dim. This is what gives the volumes an
  // edge against the dark rather than dissolving into it.
  const rim = new THREE.DirectionalLight(0x6fa8d0, 0.9)
  rim.position.set(-50, 14, -45)
  scene.add(rim)

  // A faint sky/ground bounce so the tops of things are not flat.
  scene.add(new THREE.HemisphereLight(0x33485f, 0x070a0d, 0.3))

  return key
}

function gridTexture() {
  const S = 256
  const c = document.createElement('canvas')
  c.width = S
  c.height = S
  const g = c.getContext('2d')
  g.fillStyle = '#0d1114'
  g.fillRect(0, 0, S, S)
  // Barely there. Dark grey on near black: enough to read the plane receding,
  // not enough to read as a chart.
  g.strokeStyle = 'rgba(150,180,205,0.055)'
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
  tex.repeat.set(140, 140)
  tex.anisotropy = 8
  return tex
}

export function buildGround(scene) {
  const geo = new THREE.PlaneGeometry(1400, 1400)
  const mat = new THREE.MeshStandardMaterial({
    map: gridTexture(),
    color: 0xffffff,
    roughness: 0.82,
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
export function buildTrack(scene, stations, project) {
  const group = new THREE.Group()
  const mat = new THREE.MeshStandardMaterial({
    color: COLORS.track,
    roughness: 0.85,
    metalness: 0.1,
  })

  const W = 0.55
  const H = 0.16
  for (let i = 0; i < stations.length - 1; i++) {
    const a = project(stations[i].x, stations[i].y)
    const b = project(stations[i + 1].x, stations[i + 1].y)
    const len = a.distanceTo(b)
    if (len < 1e-6) continue
    const geo = new THREE.BoxGeometry(len + W * 0.9, H, W)
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.copy(a).add(b).multiplyScalar(0.5)
    mesh.position.y = H / 2
    mesh.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x)
    mesh.receiveShadow = true
    mesh.castShadow = false
    group.add(mesh)
  }

  // Stations: small raised pads, a touch lighter than the track.
  const padMat = new THREE.MeshStandardMaterial({
    color: COLORS.station,
    roughness: 0.8,
    metalness: 0.15,
  })
  const padGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.2, 16)
  for (const st of stations) {
    const p = project(st.x, st.y)
    const pad = new THREE.Mesh(padGeo, padMat)
    pad.position.set(p.x, 0.1, p.z)
    pad.receiveShadow = true
    group.add(pad)
  }

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
  const geo = new RoundedBoxGeometry(2.6, 0.85, 1.0, 4, 0.22)
  geo.translate(0, 0.425, 0)
  const mat = new THREE.MeshStandardMaterial({
    color: COLORS.trainBody,
    emissive: COLORS.trainEmissive,
    emissiveIntensity: 0.55,
    roughness: 0.35,
    metalness: 0.25,
  })
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, count))
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

// Riders: small quiet volumes beside a platform. Sparse on purpose, capped
// low, no labels. If in doubt there are fewer of them.
export function buildRiders(scene, count) {
  const geo = new RoundedBoxGeometry(0.18, 0.44, 0.18, 2, 0.06)
  geo.translate(0, 0.22, 0)
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


// A wider label for the two captions in the comparison. Drawn into a canvas
// whose aspect matches the sprite, because stretching the square line-letter
// texture to fit a word distorts the glyphs into mush.
export function buildCaption(scene, text, position) {
  const W = 640
  const H = 128
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const g = c.getContext('2d')
  g.clearRect(0, 0, W, H)
  g.font = '500 52px "JetBrains Mono", ui-monospace, monospace'
  g.fillStyle = 'rgba(200,216,230,0.66)'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(text, W / 2, H / 2 + 2)

  const tex = new THREE.CanvasTexture(c)
  tex.anisotropy = 8
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.9 })
  )
  sprite.position.copy(position)
  sprite.position.y = 5.5
  // Aspect preserved: 640x128 is 5:1, so the sprite is too.
  sprite.scale.set(20, 4, 1)
  scene.add(sprite)
  return sprite
}
