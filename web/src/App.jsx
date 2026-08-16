import { useState } from 'react'
import Scene3D from './three/Scene3D.jsx'

// The product is the comparison.
//
// One line, two policies, running in lockstep in a single 3D world: the fixed
// timetable and the learned one. The argument is that one side bunches and the
// other does not, which you can see.

// The five lines there are run files for. Not eight: the rest of the network
// shares track with these, and modelling shared track as independent lines
// would be a claim the simulation does not support.
const LINES = ['L', 'G', '7', '1', '6']

export default function App() {
  const [playing, setPlaying] = useState(true)
  const [line, setLine] = useState('L')

  return (
    <div className="stage3d">
      {/* Keyed on the line, so choosing one rebuilds both worlds from that
          line's run files rather than trying to mutate a live scene. */}
      <Scene3D key={line} line={line} playing={playing} />

      <div className="line-picker">
        <div className="line-row">
          {LINES.map((id) => (
            <button
              key={id}
              className={'line-btn mono' + (id === line ? ' line-btn--on' : '')}
              onClick={() => setLine(id)}
            >
              {id}
            </button>
          ))}
        </div>
        {/* The transfer claim, stated plainly, because it is the strongest
            thing here and it is invisible otherwise. */}
        <div className="line-note mono">
          the policy was trained on the L only. the other four it has never seen.
        </div>
      </div>

      <div className="only-controls">
        <button className="only-control mono" onClick={() => setPlaying((p) => !p)}>
          {playing ? 'pause' : 'play'}
        </button>
      </div>
    </div>
  )
}
