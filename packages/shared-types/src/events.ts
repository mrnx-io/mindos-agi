// =============================================================================
// MindOS - Event Types
// =============================================================================

import { z } from "zod"
import { JSONSchema, TimestampSchema, UUIDSchema } from "./schemas.js"

// -----------------------------------------------------------------------------
// Event Source Types
// -----------------------------------------------------------------------------

export const EventSourceSchema = z.enum([
  "api",
  "gmail",
  "slack",
  "github",
  "calendar",
  "webhook",
  "monitor",
  "scheduler",
  "swarm",
  "internal",
])
export type EventSource = z.infer<typeof EventSourceSchema>

// -----------------------------------------------------------------------------
// Event Type Definitions
// -----------------------------------------------------------------------------

export const GoalSubmittedEventSchema = z.object({
  goal: z.string().min(1),
  priority: z.number().int().min(0).max(10).optional(),
  context: JSONSchema.optional(),
})
export type GoalSubmittedEvent = z.infer<typeof GoalSubmittedEventSchema>

export const EmailReceivedEventSchema = z.object({
  message_id: z.string(),
  from: z.string(),
  to: z.array(z.string()),
  subject: z.string(),
  body_preview: z.string(),
  has_attachments: z.boolean(),
  thread_id: z.string().optional(),
})
export type EmailReceivedEvent = z.infer<typeof EmailReceivedEventSchema>

export const SlackMessageEventSchema = z.object({
  channel: z.string(),
  user: z.string(),
  text: z.string(),
  thread_ts: z.string().optional(),
  mentions_agent: z.boolean().optional(),
})
export type SlackMessageEvent = z.infer<typeof SlackMessageEventSchema>

export const CalendarChangeEventSchema = z.object({
  event_id: z.string(),
  change_type: z.enum(["created", "updated", "deleted"]),
  title: z.string(),
  start_time: TimestampSchema,
  end_time: TimestampSchema,
  attendees: z.array(z.string()).optional(),
})
export type CalendarChangeEvent = z.infer<typeof CalendarChangeEventSchema>

export const WebhookEventSchema = z.object({
  source: z.string(),
  event_type: z.string(),
  payload: JSONSchema,
})
export type WebhookEvent = z.infer<typeof WebhookEventSchema>

export const MonitorAlertEventSchema = z.object({
  monitor_name: z.string(),
  severity: z.enum(["info", "warning", "critical"]),
  message: z.string(),
  details: JSONSchema.optional(),
})
export type MonitorAlertEvent = z.infer<typeof MonitorAlertEventSchema>

export const SwarmEventSchema = z.object({
  event_type: z.enum([
    "agent_joined",
    "agent_left",
    "delegation_requested",
    "delegation_completed",
    "consensus_started",
    "consensus_resolved",
  ]),
  agent_id: UUIDSchema.optional(),
  details: JSONSchema,
})
export type SwarmEvent = z.infer<typeof SwarmEventSchema>

// -----------------------------------------------------------------------------
// Event Payloads Union
// -----------------------------------------------------------------------------

export const EventPayloadSchema = z.union([
  GoalSubmittedEventSchema,
  EmailReceivedEventSchema,
  SlackMessageEventSchema,
  CalendarChangeEventSchema,
  WebhookEventSchema,
  MonitorAlertEventSchema,
  SwarmEventSchema,
  JSONSchema, // Fallback for unknown event types
])
export type EventPayload = z.infer<typeof EventPayloadSchema>

// -----------------------------------------------------------------------------
// Event Classification
// -----------------------------------------------------------------------------

export const EventClassificationSchema = z.object({
  urgency: z.enum(["low", "medium", "high", "critical"]),
  requires_action: z.boolean(),
  suggested_action: z.enum(["ignore", "log", "create_task", "escalate"]),
  confidence: z.number().min(0).max(1),
})
export type EventClassification = z.infer<typeof EventClassificationSchema>

// -----------------------------------------------------------------------------
// Event Record (stored in database)
// -----------------------------------------------------------------------------

export const EventSchema = z.object({
  event_id: UUIDSchema,
  identity_id: UUIDSchema,
  task_id: UUIDSchema.nullable().optional(),
  kind: z.string(),
  payload: z.unknown(),
  occurred_at: TimestampSchema,
  created_at: TimestampSchema,
})
export type Event = z.infer<typeof EventSchema>
