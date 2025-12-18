// =============================================================================
// MindOS - Logging Configuration
// =============================================================================

import pino from "pino"
import { env } from "./config.js"

const loggerOptions = {
  level: env.LOG_LEVEL,
  base: {
    service: "mind-service",
  },
}

// Add pretty printing in development only
// Using spread to avoid exactOptionalPropertyTypes issues with undefined
export const logger = pino(
  process.env.NODE_ENV !== "production"
    ? {
        ...loggerOptions,
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        },
      }
    : loggerOptions
)

// Create child loggers for different modules
export function createLogger(module: string) {
  return logger.child({ module })
}
