import { NextResponse } from "next/server"
import { invokeService } from "@/lib/restate"

export const runtime = "nodejs"

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      display_name?: string
    }

    const displayName =
      body.display_name ?? process.env.MINDOS_DEFAULT_IDENTITY_NAME ?? "MindOS Creator"

    const result = await invokeService<{ identity_id: string }>("identity", "create", {
      display_name: displayName,
    })

    return NextResponse.json({ identityId: result.identity_id })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
