import { EVEN_HEADWAY } from './interp.js'

// One train, connected to the rule.
//
// The boundary panel shows the rule over the whole fleet at once, which is the
// argument but not an explanation. Picking a single train and reading its two
// gaps against the same numbers is what turns the surface into something a
// judge can check: this train is here, it has closed up on the one ahead, and
// that is why it is being held.

function Gap({ label, value }) {
  if (typeof value !== 'number') return null
  const even = EVEN_HEADWAY
  const delta = value - even
  const state =
    Math.abs(delta) <= 0.05 ? 'even' : delta < 0 ? 'closed up' : 'fallen behind'
  return (
    <div className="insp-gap">
      <div className="insp-label mono">{label}</div>
      <div className="insp-value mono">{value.toFixed(2)}</div>
      <div className={`insp-state mono insp-${state.replace(' ', '-')}`}>{state}</div>
    </div>
  )
}

export default function Inspector({ train, line, onClear }) {
  if (!train) {
    return (
      <div className="inspector inspector-empty mono">
        click any train on the map to see the two numbers it decides on
      </div>
    )
  }

  const obs = train.obs || {}
  const ahead = obs.headway_ahead_ratio
  const behind = obs.headway_behind_ratio
  const hasObs = typeof ahead === 'number' && typeof behind === 'number'

  return (
    <div className="inspector">
      <div className="insp-id mono">
        <span className="insp-chip">{line}</span> train {train.index + 1}
        {train.holding ? <span className="insp-hold">waiting at the platform</span> : null}
      </div>

      {hasObs ? (
        <>
          <Gap label="gap to the train ahead" value={ahead} />
          <Gap label="gap to the train behind" value={behind} />
          <div className="insp-read">
            {train.holding
              ? 'it is waiting, letting the gap ahead open back up.'
              : ahead < EVEN_HEADWAY - 0.05
                ? 'it has caught the train ahead, so the rule says wait.'
                : 'gaps are close to even, so the rule says go.'}
          </div>
        </>
      ) : (
        <div className="insp-read">this run does not carry the two gap values.</div>
      )}

      <button className="insp-clear mono" onClick={onClear}>
        clear
      </button>
    </div>
  )
}
