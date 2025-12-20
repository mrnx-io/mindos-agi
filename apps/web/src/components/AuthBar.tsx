"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import type { User } from "@supabase/supabase-js"
import { createSupabaseBrowserClient } from "@/lib/supabase/browser"

export default function AuthBar() {
  const router = useRouter()
  const [supabase, setSupabase] = useState<ReturnType<typeof createSupabaseBrowserClient> | null>(
    null
  )
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setSupabase(createSupabaseBrowserClient())
  }, [])

  useEffect(() => {
    if (!supabase) return
    let isMounted = true

    setLoading(true)
    supabase.auth.getUser().then(({ data }) => {
      if (!isMounted) return
      setUser(data.user ?? null)
      setLoading(false)
    })

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!isMounted) return
      setUser(session?.user ?? null)
    })

    return () => {
      isMounted = false
      data.subscription.unsubscribe()
    }
  }, [supabase])

  const handleSignOut = async () => {
    if (!supabase) return
    await supabase.auth.signOut()
    router.refresh()
    router.push("/login")
  }

  return (
    <div className="auth-bar">
      <div className="auth-user">
        <span className="auth-label">Account</span>
        {loading ? (
          <span className="auth-email">Loading…</span>
        ) : user?.email ? (
          <span className="auth-email">{user.email}</span>
        ) : (
          <span className="auth-email">Signed out</span>
        )}
      </div>
      <div className="auth-actions">
        {user ? (
          <button className="auth-button" type="button" onClick={handleSignOut}>
            Sign out
          </button>
        ) : (
          <button className="auth-button" type="button" onClick={() => router.push("/login")}>
            Sign in
          </button>
        )}
      </div>
    </div>
  )
}
