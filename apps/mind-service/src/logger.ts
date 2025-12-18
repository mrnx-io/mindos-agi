// =============================================================================
// MindOS - Logging Configuration
// =============================================================================

import pino from "pino"
import { env } from "./config.js"

export const logger = pino({
  level: env.LOG_LEVEL,
  transport:
    process.env.NODE_ENV !== "production"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        }
      : undefined,
  base: {
    service: "mind-service",
  },
})

// Create child loggers for different modules
export function createLogger(module: string) {
  return logger.child({ module })
}
