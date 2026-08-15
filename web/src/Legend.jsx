import { WAIT_COLORS } from './palette.js'

// Persistent key for the map. Every mark on screen is explained here, in the
// words a rider would use, and it never scrolls away or collapses. A judge who
// looks up from the trains should not have to hunt for what a colour means.
export default function Legend() {
  return (
    <div className="legend">
      <div className="legend-group">
        <span className="legend-title">people waiting</span>
        <span className="legend-item">
          <i className="swatch" style={{ background: WAIT_COLORS.calm }} />
          just arrived
        </span>
        <span className="legend-item">
          <i className="swatch" style={{ background: WAIT_COLORS.waiting }} />
          waiting a while
        </span>
        <span className="legend-item">
          <i className="swatch" style={{ background: WAIT_COLORS.stranded }} />
          waiting too long
        </span>
      </div>

      <div className="legend-group">
        <span className="legend-item">
          <i className="swatch swatch-train" />
          each capsule is a train
        </span>
        <span className="legend-item">
          <i className="swatch swatch-hold" />
          a ring means it is waiting at the platform on purpose
        </span>
      </div>

      <div className="legend-group">
        <span className="legend-item legend-wide">
          the spacing number is 0 when every train is perfectly evenly spaced, and rises as
          they bunch together
        </span>
      </div>
    </div>
  )
}
