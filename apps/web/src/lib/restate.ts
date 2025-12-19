const RESTATE_INGRESS_URL = process.env.RESTATE_INGRESS_URL
const RESTATE_API_KEY = process.env.RESTATE_API_KEY

if (!RESTATE_INGRESS_URL) {
  throw new Error("RESTATE_INGRESS_URL is not set")
}

const baseUrl = RESTATE_INGRESS_URL.replace(/\/$/, "")

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }
  if (RESTATE_API_KEY) {
    headers.Authorization = `Bearer ${RESTATE_API_KEY}`
  }
  return headers
}

export async function invokeService<TResponse>(
  service: string,
  handler: string,
  body: unknown
): Promise<TResponse> {
  const response = await fetch(`${baseUrl}/${service}/${handler}`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body ?? {}),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Restate invocation failed (${response.status}): ${text}`)
  }

  return (await response.json()) as TResponse
}

export async function invokeObject<TResponse>(
  service: string,
  key: string,
  handler: string,
  body?: unknown
): Promise<TResponse> {
  const response = await fetch(`${baseUrl}/${service}/${encodeURIComponent(key)}/${handler}`, {
    method: "POST",
    headers: buildHeaders(),
    body: JSON.stringify(body ?? {}),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Restate invocation failed (${response.status}): ${text}`)
  }

  return (await response.json()) as TResponse
}
