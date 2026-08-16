import { useState } from 'react'
import Scene3D from './three/Scene3D.jsx'

// The product is the 3D scene.
//
// The old 2D views, the view switcher, the scrubber, the ribbons, the metric
// panels and every readout are gone. Two simulations standing side by side in
// one world is the whole argument: one bunches, the other does not, and that is
// visible without a single number on screen.

export default function App() {
  const [playing, setPlaying] = useState(true)
  const [mode, setMode] = useState('single')

  return (
    <div className="stage3d">
      <Scene3D playing={playing} mode={mode} />
      <div className="only-controls">
        <button className="only-control mono" onClick={() => setPlaying((p) => !p)}>
          {playing ? 'pause' : 'play'}
        </button>
        <button
          className="only-control mono"
          onClick={() => setMode((m) => (m === 'single' ? 'compare' : 'single'))}
        >
          {mode === 'single' ? 'compare' : 'network'}
        </button>
      </div>
    </div>
  )
}
