import { Suspense } from "react"
import LoginClient from "./LoginClient"

function LoginFallback() {
  return (
    <main className="auth-page">
      <div className="auth-shell">
        <div className="auth-card">
          <div className="auth-header">
            <p className="stat-title">MindOS Studio</p>
            <h1>Preparing sign-in…</h1>
            <p className="subtitle">Warming up your secure session.</p>
          </div>
        </div>
      </div>
    </main>
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginClient />
    </Suspense>
  )
}
