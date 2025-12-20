"use client"

import { useChat } from "@ai-sdk/react"
import { TextStreamChatTransport } from "ai"
import { useEffect, useMemo, useState } from "react"

const STORAGE_KEY = "mindos_identity_id"

function extractText(message: unknown): string {
  if (!message || typeof message !== "object") return ""
  if ("content" in message && typeof message.content === "string") {
    return message.content
  }
  if ("text" in message && typeof message.text === "string") {
    return message.text
  }
  if ("parts" in message && Array.isArray(message.parts)) {
    return message.parts
      .map((part: { type?: string; text?: string }) =>
        part.type === "text" ? part.text ?? "" : ""
      )
      .join("")
  }
  return ""
}

export default function ChatPanel() {
  const defaultDisplayName =
    process.env.NEXT_PUBLIC_MINDOS_DISPLAY_NAME ?? "MindOS Creator"
  const presetIdentityId = process.env.NEXT_PUBLIC_MINDOS_IDENTITY_ID

  const [identityId, setIdentityId] = useState<string | null>(presetIdentityId ?? null)
  const [identityStatus, setIdentityStatus] = useState<string | null>(null)
  const [input, setInput] = useState("")

  useEffect(() => {
    if (presetIdentityId) {
      localStorage.setItem(STORAGE_KEY, presetIdentityId)
      return
    }

    const cached = localStorage.getItem(STORAGE_KEY)
    if (cached) {
      setIdentityId(cached)
      return
    }

    const createIdentity = async () => {
      setIdentityStatus("Creating your identity...")
      try {
        const response = await fetch("/api/identity", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ display_name: defaultDisplayName }),
        })
        const data = (await response.json()) as { identityId?: string }
        if (data.identityId) {
          localStorage.setItem(STORAGE_KEY, data.identityId)
          setIdentityId(data.identityId)
          setIdentityStatus(null)
        } else {
          setIdentityStatus("Identity creation failed. Check backend connectivity.")
        }
      } catch (error) {
        setIdentityStatus("Identity creation failed. Check backend connectivity.")
      }
    }

    createIdentity()
  }, [defaultDisplayName, presetIdentityId])

  const transport = useMemo(() => {
    return new TextStreamChatTransport({
      api: "/api/chat",
      prepareSendMessagesRequest({ messages }) {
        return {
          body: {
            message: messages[messages.length - 1],
            identityId,
          },
        }
      },
    })
  }, [identityId])

  const { messages, sendMessage, status: chatStatus } = useChat({
    transport,
  })
  const isBusy = chatStatus === "submitted" || chatStatus === "streaming"

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!input.trim()) return

    if (!identityId) {
      setIdentityStatus("Identity not ready yet. Please wait...")
      return
    }

    sendMessage({ text: input })
    setInput("")
  }

  return (
    <section className="chat-card">
      <div className="chat-header">
        <h2>Session Console</h2>
        <span className="identity-pill">
          {identityId ? "Identity linked" : "Initializing"}
        </span>
      </div>
      <div className="chat-log">
        {messages.length === 0 ? (
          <div className="message assistant">
            <small>MindOS</small>
            <p>
              Ask for anything: strategy, creative synthesis, research plans, or systems design.
            </p>
          </div>
        ) : null}
        {messages.map((message) => (
          <div
            key={message.id}
            className={`message ${message.role === "user" ? "user" : "assistant"}`}
          >
            <small>{message.role === "user" ? "You" : "MindOS"}</small>
            <p>{extractText(message) || "…"}</p>
          </div>
        ))}
      </div>
      {identityStatus ? <p className="notice">{identityStatus}</p> : null}
      <form className="chat-form" onSubmit={handleSubmit}>
        <input
          value={input}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
            setInput(event.target.value)
          }
          placeholder="Describe your next mission…"
        />
        <button type="submit" disabled={isBusy || !identityId}>
          {isBusy ? "Thinking…" : "Send"}
        </button>
      </form>
    </section>
  )
}
