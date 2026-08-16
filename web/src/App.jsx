import { useEffect, useState } from 'react'
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

// The picker stays out of the way until the L has had time to make its point on
// its own. A judge who meets five buttons in the first second starts pressing
// them instead of watching the trains.
const PICKER_AFTER_MS = 20000

export default function App() {
  const [playing, setPlaying] = useState(true)
  const [line, setLine] = useState('L')
  const [pickerIn, setPickerIn] = useState(false)

  useEffect(() => {
    const id = setTimeout(() => setPickerIn(true), PICKER_AFTER_MS)
    return () => clearTimeout(id)
  }, [])

  return (
    <div className="stage3d">
      {/* Keyed on the line, so choosing one rebuilds both worlds from that
          line's run files rather than trying to mutate a live scene. */}
      <Scene3D key={line} line={line} playing={playing} />

      <div className={'line-picker' + (pickerIn ? ' line-picker--in' : '')}>
        <div className="line-note mono">
          trained on the L only. the other four it has never seen.
        </div>
        <div className="line-row">
          {LINES.map((id) => (
            <button
              key={id}
              className={'line-btn mono' + (id === line ? ' line-btn--on' : '')}
              onClick={() => setLine(id)}
              aria-pressed={id === line}
            >
              {id}
            </button>
          ))}
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
