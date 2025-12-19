import ChatPanel from "../components/ChatPanel"

export default function HomePage() {
  return (
    <main>
      <div className="app-shell">
        <section className="hero">
          <div>
            <div className="stat-title">MindOS Personal Studio</div>
            <h1 className="brand">Your living, multi-model creative cortex.</h1>
          </div>
          <p className="subtitle">
            This interface streams directly into your MindOS deployment, orchestrating the
            toolmesh, executor, grounding, and swarm layers. Use it as your personal creative
            command center.
          </p>
          <div className="stat-grid">
            <div className="stat-card">
              <div className="stat-title">Models Online</div>
              <div className="stat-value">OpenAI · Anthropic · Google · xAI</div>
            </div>
            <div className="stat-card">
              <div className="stat-title">Core Systems</div>
              <div className="stat-value">Evidence · Metacognition · World Model</div>
            </div>
            <div className="stat-card">
              <div className="stat-title">Tools & MCP</div>
              <div className="stat-value">Search · Code · Files · APIs</div>
            </div>
            <div className="stat-card">
              <div className="stat-title">Operational Mode</div>
              <div className="stat-value">Private, single-user</div>
            </div>
          </div>
          <p className="notice">
            Tip: Keep this page open while MindOS executes long-running tasks. Streaming updates
            appear live in the console.
          </p>
        </section>
        <ChatPanel />
      </div>
    </main>
  )
}
