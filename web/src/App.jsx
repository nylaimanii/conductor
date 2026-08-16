import { useState } from 'react'
import Scene3D from './three/Scene3D.jsx'

// The product is the comparison.
//
// One line, two policies, running in lockstep in a single 3D world: the fixed
// timetable and the learned one. Everything else was scaffolding and is gone.
// Two controls, and no numbers anywhere. The argument is that one side bunches
// and the other does not, which you can see.

export default function App() {
  const [playing, setPlaying] = useState(true)

  return (
    <div className="stage3d">
      <Scene3D playing={playing} />
      <div className="only-controls">
        <button className="only-control mono" onClick={() => setPlaying((p) => !p)}>
          {playing ? 'pause' : 'play'}
        </button>
      </div>
    </div>
  )
}
