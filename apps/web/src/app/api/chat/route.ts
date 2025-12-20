import { invokeObject } from "@/lib/restate"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const POLL_INTERVAL_MS = Number(process.env.MINDOS_POLL_INTERVAL_MS ?? "2000")
const MAX_STREAM_MS = Number(process.env.MINDOS_STREAM_TIMEOUT_MS ?? "120000")

type UIMessagePart = {
  type?: string
  text?: string
}

type UIMessage = {
  content?: string
  text?: string
  parts?: UIMessagePart[]
}

type TaskStep = {
  step_idx?: number
  kind?: string
  name?: string
  summary?: string
  output?: unknown
  result?: { success?: boolean; output?: unknown }
}

type TaskStatusResponse = {
  status?: string
  steps?: TaskStep[]
}

function extractText(message?: UIMessage): string {
  if (!message) return ""
  if (typeof message.content === "string") return message.content
  if (typeof message.text === "string") return message.text
  if (Array.isArray(message.parts)) {
    return message.parts
      .map((part) => (part.type === "text" ? part.text ?? "" : ""))
      .join("")
  }
  return ""
}

function formatStep(step: TaskStep): string {
  const index = typeof step.step_idx === "number" ? step.step_idx + 1 : undefined
  const header = [index ? `Step ${index}` : null, step.kind, step.name]
    .filter(Boolean)
    .join(" · ")
  const summary = step.summary ??
    (typeof step.output === "string" ? step.output : undefined) ??
    (step.result?.output ? JSON.stringify(step.result.output, null, 2) : undefined)
  const payload = summary ? `\n${truncate(summary, 1200)}` : ""
  return `${header || "Task update"}${payload}`
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n… (truncated)`
}

function isTerminal(status?: string): boolean {
  if (!status) return false
  return ["done", "completed", "failed", "cancelled", "blocked", "rejected"].includes(status)
}

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    message?: UIMessage
    identityId?: string
  }

  const identityId = body.identityId
  const goal = extractText(body.message)

  if (!identityId || !goal) {
    return new Response("Missing identityId or message", { status: 400 })
  }

  let taskId: string

  try {
    const result = await invokeObject<{ taskId?: string; task_id?: string }>(
      "mind",
      identityId,
      "submitGoal",
      {
        goal,
        metadata: { source: "mindos-web" },
      }
    )
    taskId = result.taskId ?? result.task_id ?? ""
    if (!taskId) {
      throw new Error("Missing task id in response")
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return new Response(`Failed to submit goal: ${message}`, { status: 500 })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => controller.enqueue(encoder.encode(`${text}\n\n`))

      write(`Task queued: ${taskId}`)

      let lastStepIndex = 0
      const startedAt = Date.now()

      const poll = async () => {
        while (Date.now() - startedAt < MAX_STREAM_MS) {
          try {
            const status = await invokeObject<TaskStatusResponse>(
              "task",
              taskId,
              "getStatus",
              {}
            )

            if (status.steps && status.steps.length > lastStepIndex) {
              const newSteps = status.steps.slice(lastStepIndex)
              newSteps.forEach((step) => write(formatStep(step)))
              lastStepIndex = status.steps.length
            }

            if (status.status === "waiting_approval") {
              write("Task awaiting approval. Check the approvals queue.")
            }

            if (isTerminal(status.status)) {
              write(`Task finished with status: ${status.status}`)
              break
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error"
            write(`Status check failed: ${message}`)
            break
          }

          await delay(POLL_INTERVAL_MS)
        }

        if (Date.now() - startedAt >= MAX_STREAM_MS) {
          write("Streaming timeout reached. Task may still be running.")
        }

        controller.close()
      }

      void poll()
    },
  })

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  })
}
