import { createServerClient } from "@supabase/ssr"
import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

const REALM = "MindOS"

const AUTH_EXEMPT_PATHS = ["/login", "/auth/callback"]

const unauthorized = () =>
  new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": `Basic realm=\"${REALM}\"`,
    },
  })

const apiUnauthorized = () =>
  new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  })

function checkBasicAuth(req: NextRequest) {
  const user = process.env.BASIC_AUTH_USER
  const pass = process.env.BASIC_AUTH_PASSWORD

  if (!user || !pass) {
    return null
  }

  const authHeader = req.headers.get("authorization")
  if (!authHeader) {
    return unauthorized()
  }

  const [scheme, encoded] = authHeader.split(" ")
  if (scheme !== "Basic" || !encoded) {
    return unauthorized()
  }

  let decoded = ""
  try {
    decoded = atob(encoded)
  } catch {
    return unauthorized()
  }

  const separatorIndex = decoded.indexOf(":")
  if (separatorIndex === -1) {
    return unauthorized()
  }

  const reqUser = decoded.slice(0, separatorIndex)
  const reqPass = decoded.slice(separatorIndex + 1)

  if (reqUser !== user || reqPass !== pass) {
    return unauthorized()
  }

  return null
}

export async function middleware(req: NextRequest) {
  const basicResult = checkBasicAuth(req)
  if (basicResult) return basicResult

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.next()
  }

  const path = req.nextUrl.pathname
  const isAuthRoute = AUTH_EXEMPT_PATHS.some((prefix) => path.startsWith(prefix))

  let response = NextResponse.next({ request: req })

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return req.cookies.getAll()
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => req.cookies.set(name, value))
        response = NextResponse.next({ request: req })
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options)
        })
      },
    },
  })

  const {
    data: { session },
  } = await supabase.auth.getSession()

  if (!session && !isAuthRoute) {
    if (path.startsWith("/api")) {
      return apiUnauthorized()
    }
    const redirectUrl = new URL("/login", req.url)
    redirectUrl.searchParams.set("redirectTo", path)
    return NextResponse.redirect(redirectUrl)
  }

  return response
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
}
