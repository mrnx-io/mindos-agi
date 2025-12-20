"use client"

import { useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { createSupabaseBrowserClient } from "@/lib/supabase/browser"

type AuthMode = "sign-in" | "sign-up"

export default function LoginClient() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const redirectTo = searchParams.get("redirectTo") ?? "/"

  const [supabase, setSupabase] = useState<ReturnType<typeof createSupabaseBrowserClient> | null>(
    null
  )

  const [mode, setMode] = useState<AuthMode>("sign-in")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)

  useEffect(() => {
    setSupabase(createSupabaseBrowserClient())
  }, [])

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setStatus(null)

    if (!supabase) {
      setError("Authentication is initializing. Please retry in a moment.")
      return
    }

    setIsBusy(true)

    try {
      if (mode === "sign-in") {
        const { error: signInError } = await supabase.auth.signInWithPassword({
          email,
          password,
        })

        if (signInError) throw signInError

        router.push(redirectTo)
        router.refresh()
        return
      }

      const redirectUrl = `${window.location.origin}/auth/callback`
      const { data, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: redirectUrl,
        },
      })

      if (signUpError) throw signUpError

      if (data?.session) {
        router.push(redirectTo)
        router.refresh()
        return
      }

      setStatus("Check your email to confirm the new account.")
    } catch (err) {
      const message = err instanceof Error ? err.message : "Authentication failed."
      setError(message)
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-shell">
        <div className="auth-card">
          <div className="auth-header">
            <p className="stat-title">MindOS Studio</p>
            <h1>{mode === "sign-in" ? "Welcome back" : "Create your account"}</h1>
            <p className="subtitle">
              Sign in to connect your private MindOS deployment and resume your creative sessions.
            </p>
          </div>
          <form className="auth-form" onSubmit={handleSubmit}>
            <label className="auth-field">
              <span>Email</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.currentTarget.value)}
                required
                autoComplete="email"
                placeholder="you@studio.com"
              />
            </label>
            <label className="auth-field">
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.currentTarget.value)}
                required
                minLength={8}
                autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
                placeholder="At least 8 characters"
              />
            </label>

            {error ? <p className="auth-error">{error}</p> : null}
            {status ? <p className="auth-status">{status}</p> : null}

            <button className="auth-submit" type="submit" disabled={isBusy || !supabase}>
              {isBusy
                ? "Working..."
                : !supabase
                  ? "Initializing..."
                  : mode === "sign-in"
                    ? "Sign in"
                    : "Create account"}
            </button>
          </form>
          <div className="auth-toggle">
            <span>
              {mode === "sign-in" ? "New to MindOS?" : "Already have an account?"}
            </span>
            <button
              type="button"
              onClick={() => setMode(mode === "sign-in" ? "sign-up" : "sign-in")}
            >
              {mode === "sign-in" ? "Create account" : "Sign in instead"}
            </button>
          </div>
        </div>
      </div>
    </main>
  )
}
