
import { useState } from 'react'
import './App.css'

type Stage = {
  number: string
  name: string
  detail: string
  status: string
}

const stages: Stage[] = [
  {
    number: '01',
    name: 'Source',
    detail: 'Connect a GitHub repository and select the branch to deploy.',
    status: 'Waiting for repository',
  },
  {
    number: '02',
    name: 'Build',
    detail: 'Install dependencies and compile the application.',
    status: 'Build not started',
  },
  {
    number: '03',
    name: 'Test',
    detail: 'Run automated checks before releasing your application.',
    status: 'Tests not started',
  },
  {
    number: '04',
    name: 'Deploy',
    detail: 'Prepare your production release for the target environment.',
    status: 'Awaiting deployment',
  },
]

function App() {
  const [activeStage, setActiveStage] = useState(0)
  const [showDetails, setShowDetails] = useState(false)

  return (
    <main className="deployflow">
      <nav className="topbar">
        <a className="brand" href="#home" aria-label="DeployFlow home">
          <span className="brand-mark">D<span>.</span></span>
          <span>deployflow</span>
        </a>

        <div className="nav-center">
          <a href="#workflow">Workflow</a>
          <a href="#architecture">Architecture</a>
          <a href="#about">About</a>
        </div>

        <a className="nav-cta" href="#workflow">
          Explore platform <span>↗</span>
        </a>
      </nav>

      <section className="hero-section" id="home">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="status-dot" />
            AUTOMATION FOR THE CLOUD
          </div>

          <h1>
            From code
            <br />
            to <em>cloud.</em>
          </h1>

          <p className="hero-description">
            A clearer path from your first commit to your next release.
            Orchestrate the steps, understand every stage, and bring your
            deployments into focus.
          </p>

          <div className="hero-actions">
            <a className="primary-button" href="#workflow">
              Explore the workflow <span>↗</span>
            </a>
            <a className="text-button" href="#architecture">
              Discover the architecture <span>↓</span>
            </a>
          </div>

          <div className="hero-footnote">
            <span>DESIGNED FOR DEVELOPERS</span>
            <span>BUILT FOR THE CLOUD</span>
          </div>
        </div>

        <div className="hero-art" aria-label="Illustration of cloud deployment">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />

          <div className="sun-disc" />

          <div className="cloud-scene">
            <div className="cloud cloud-back" />
            <div className="cloud cloud-front">
              <span className="cloud-core">D</span>
            </div>
          </div>

          <div className="floating-chip chip-source">
            <span className="chip-icon">⌘</span>
            <span>
              <small>01 / SOURCE</small>
              <strong>Git push</strong>
            </span>
          </div>

          <div className="floating-chip chip-build">
            <span className="chip-icon">↗</span>
            <span>
              <small>02 / PIPELINE</small>
              <strong>Build & test</strong>
            </span>
          </div>

          <div className="art-caption">
            <span>FIG. 01</span>
            <span>THE JOURNEY TO PRODUCTION</span>
          </div>
        </div>

        <div className="chapter-label">
          <span>01</span>
          <span>THE IDEA</span>
          <span className="chapter-line" />
        </div>
      </section>

      <section className="manifesto" id="about">
        <div className="section-index">
          <span>02 / THE PRINCIPLE</span>
          <span>LESS FRICTION. MORE FLOW.</span>
        </div>

        <div className="manifesto-content">
          <h2>
            Every release
            <br />
            should feel <em>intentional.</em>
          </h2>
          <p>
            DeployFlow brings the journey into one view. From source code to
            production, each stage has a purpose, each transition has context,
            and every release deserves clarity.
          </p>
        </div>
      </section>

      <section className="workflow-section" id="workflow">
        <div className="section-index">
          <span>03 / THE WORKFLOW</span>
          <span>FOUR STAGES. ONE FLOW.</span>
        </div>

        <div className="workflow-heading">
          <div>
            <span className="eyebrow">YOUR RELEASE, VISUALIZED</span>
            <h2>Make every step <em>visible.</em></h2>
          </div>
          <p>
            Select a stage to explore what happens along the way.
            This demonstration is interactive; it does not deploy real code.
          </p>
        </div>

        <div className="pipeline-panel">
          <div className="pipeline-top">
            <div>
              <span className="panel-kicker">DEPLOYMENT PIPELINE</span>
              <h3>Application release</h3>
            </div>
            <span className="demo-badge">
              <span className="status-dot" />
              DEMO MODE
            </span>
          </div>

          <div className="pipeline-track">
            {stages.map((stage, index) => (
              <button
                className={`stage-node ${activeStage === index ? 'active' : ''}`}
                key={stage.number}
                type="button"
                onClick={() => {
                  setActiveStage(index)
                  setShowDetails(true)
                }}
                aria-pressed={activeStage === index}
              >
                <span className="stage-number">{stage.number}</span>
                <span className="stage-name">{stage.name}</span>
                <span className="stage-indicator" />
              </button>
            ))}
          </div>

          <div className="stage-detail">
            <div className="stage-detail-number">{stages[activeStage].number}</div>
            <div className="stage-detail-copy">
              <span className="panel-kicker">CURRENT STAGE</span>
              <h3>{stages[activeStage].name}</h3>
              <p>{stages[activeStage].detail}</p>
              {showDetails && (
                <p className="stage-status">{stages[activeStage].status}</p>
              )}
            </div>
            <button
              className="next-stage-button"
              type="button"
              onClick={() => {
                setActiveStage((current) => (current + 1) % stages.length)
                setShowDetails(true)
              }}
            >
              Next stage <span>→</span>
            </button>
          </div>

          <div className="pipeline-footer">
            <span>RELEASE OVERVIEW / 001</span>
            <span>SIMULATED WORKFLOW · NO LIVE DEPLOYMENT</span>
          </div>
        </div>
      </section>

      <section className="architecture-section" id="architecture">
        <div className="section-index">
          <span>04 / THE DESTINATION</span>
          <span>CODE MEETS INFRASTRUCTURE</span>
        </div>

        <div className="architecture-content">
          <div>
            <span className="eyebrow">A THOUGHTFUL ROUTE TO AWS</span>
            <h2>
              From repository
              <br />
              to <em>real infrastructure.</em>
            </h2>
            <p>
              The next stage of DeployFlow can connect a repository to an
              automated build, validate the release, and deploy to AWS through
              a controlled pipeline.
            </p>
            <a className="text-button dark-text" href="#workflow">
              Return to the workflow <span>↑</span>
            </a>
          </div>

          <div className="architecture-diagram">
            <div className="diagram-node node-github">
              <span className="diagram-symbol">⌘</span>
              <span>Repository</span>
              <small>GITHUB</small>
            </div>
            <div className="diagram-connector"><span>01</span></div>
            <div className="diagram-node node-actions">
              <span className="diagram-symbol">↗</span>
              <span>Build pipeline</span>
              <small>CI / CD</small>
            </div>
            <div className="diagram-connector"><span>02</span></div>
            <div className="diagram-node node-aws">
              <span className="diagram-symbol">☁</span>
              <span>Cloud target</span>
              <small>AWS</small>
            </div>
            <p className="diagram-note">
              CONCEPTUAL ARCHITECTURE · INTEGRATION NOT YET CONNECTED
            </p>
          </div>
        </div>
      </section>

      <footer className="footer">
        <a className="brand footer-brand" href="#home">
          <span className="brand-mark">D<span>.</span></span>
          <span>deployflow</span>
        </a>
        <p>Less friction between an idea and its release.</p>
        <a className="back-top" href="#home">BACK TO TOP ↑</a>
        <span className="footer-year">INDEPENDENT PROJECT · 2026</span>
      </footer>
    </main>
  )
}

export default App
