import { z } from "zod"

export const BOT_ERROR_DIAGNOSTIC_ID_LIMIT = 160
/** Identifiers are labels, never URLs, response bodies or arbitrary error text. */
export const botErrorDiagnosticIdSchema = z.string().regex(/^[a-zA-Z0-9._:-]{1,160}$/)

export const botErrorDiagnosticSchema = z
  .object({
    code: botErrorDiagnosticIdSchema,
    status: z.number().int().min(100).max(599).optional(),
    /** Actual provider HTTP x-request-id or verified SDK APIError.requestID. */
    requestId: botErrorDiagnosticIdSchema.optional(),
    /** Host/transport-local correlation; never presented as a provider ID. */
    correlationId: botErrorDiagnosticIdSchema.optional(),
    /** The durable model usage reservation for this exact invocation. */
    callId: botErrorDiagnosticIdSchema.optional()
  })
  .strict()

export type BotErrorDiagnostic = z.infer<typeof botErrorDiagnosticSchema>

/** Optional diagnostics keep older Host/contextBridge failures readable. */
export const botSerializedFailureSchema = z
  .object({
    code: botErrorDiagnosticIdSchema,
    message: z.string().min(1).max(2000),
    diagnostic: botErrorDiagnosticSchema.optional()
  })
  .strict()
export type BotSerializedFailure = z.infer<typeof botSerializedFailureSchema>
