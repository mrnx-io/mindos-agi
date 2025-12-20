import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

const REALM = "MindOS"

const unauthorized = () =>
  new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": `Basic realm=\"${REALM}\"`,
    },
  })

export function middleware(req: NextRequest) {
  const user = process.env.BASIC_AUTH_USER
  const pass = process.env.BASIC_AUTH_PASSWORD

  if (!user || !pass) {
    return NextResponse.next()
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

  return NextResponse.next()
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
}
