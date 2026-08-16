import { Link } from 'react-router-dom'

// Four screens, in order, with one idea on each.
//
// The sequence is the whole design: the problem carries no numbers, the
// question carries no numbers, and the first figure on the page appears only
// after a judge already knows what it would mean. Nothing here is a card and
// nothing here is a box. Space and weight do the separating.

export default function Landing() {
  return (
    <main className="lp">
      <section id="problem" className="lp-scene lp-scene--problem">
        <p className="lp-brand mono">HEADWAY</p>
        <h1 className="lp-h1 display">
          <span>you’re not late because the train is slow.</span>
          <span>you’re not late because three of them showed up at once.</span>
        </h1>
        <p className="lp-sub mono">
          every train runs a fixed schedule. no train knows where the others are.
        </p>
      </section>

      <section id="question" className="lp-scene">
        <p className="lp-eyebrow mono">the question</p>
        <h2 className="lp-h2 display">what if the trains decided for themselves when to wait?</h2>
        <p className="lp-sub mono">
          one choice, made by every train, every few seconds. hold at the platform, or go.
        </p>
      </section>

      <section id="result" className="lp-scene">
        <p className="lp-eyebrow mono">the result</p>

        <div className="lp-stats">
          <div className="lp-stat">
            <p className="lp-stat-line display">
              bunching down <span className="lp-num mono">69</span> to{' '}
              <span className="lp-num mono">88</span> percent
            </p>
            <p className="lp-sub mono">
              against a timetable calibrated line by line from real MTA data
            </p>
          </div>

          <div className="lp-stat">
            <p className="lp-stat-line display">
              long gaps down <span className="lp-num mono">48</span> to{' '}
              <span className="lp-num mono">98</span> percent
            </p>
            <p className="lp-sub mono">the moments when nothing comes for ages</p>
          </div>
        </div>

        <p className="lp-honest mono">
          average wait stays about the same. this makes service consistent, not faster.
        </p>

        <p className="lp-zeroshot mono">
          it only ever trained on the L. the other four lines it had never seen.
        </p>
      </section>

      <section id="rule" className="lp-scene">
        <p className="lp-eyebrow mono">the rule it taught itself</p>
        <h2 className="lp-h2 lp-h2--rule display">
          hold when you’ve caught up to the train ahead and the one behind is far back. go when
          you’re running late and the follower is on your tail.
        </h2>
        <p className="lp-credit mono">
          nobody wrote that rule. the reward only counted how many people were waiting. it worked
          the rest out on its own.
        </p>
        <Link className="lp-go mono" to="/try">
          try it
        </Link>
      </section>
    </main>
  )
}
