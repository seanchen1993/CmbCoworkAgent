import { z } from "zod"

const id = z.string().regex(/^[a-zA-Z0-9][\w.-]{0,79}$/)
const paths = z.array(z.string().min(1).max(512)).max(4096)
const ids = z.array(id).max(64)
const declaration = z.record(z.string(), z.unknown())
const dependencies = z.object({ required: ids, advisory: ids }).strict()
const pluginFields = z
  .object({
    hooks: z.unknown().optional(),
    skills: z.unknown().optional(),
    mcpServers: z.unknown().optional(),
    description: z.unknown().optional(),
    author: z.unknown().optional(),
    license: z.unknown().optional(),
    keywords: z.array(z.string()).optional(),
    useScenario: z.string().optional(),
    userConfig: declaration.optional()
  })
  .strict()

/** Discoverable structure only. The existing parser/assembler still validate execution semantics. */
export const businessModCatalogSchema = z
  .object({
    apiVersion: z.literal("devclaw.business-mods/v1"),
    kind: z.literal("catalog"),
    kernel: z
      .object({
        id,
        version: z.string(),
        resources: paths,
        boardConfigPath: z.string().optional(),
        pluginFields: pluginFields.optional(),
        runtime: z
          .object({
            adapter: z.enum(["autobiz-v1", "host-linear-v1"]),
            capabilities: z
              .object({
                execution: z.boolean(),
                conditionalTransition: z.boolean(),
                idempotency: z.boolean(),
                reconciliation: z.boolean(),
                cancellation: z.boolean()
              })
              .strict()
              .optional()
          })
          .strict()
          .optional()
      })
      .strict()
      .optional(),
    kernelRef: z.object({ id, version: z.string() }).optional(),
    modules: z
      .array(
        z
          .object({
            id,
            title: z.string().min(1).max(160),
            node: z
              .object({ id, skill: id })
              .catchall(z.unknown())
              .describe("Preserve every original node field, including artifacts and checks"),
            skill: z.object({ entry: z.string(), resources: paths }).strict(),
            resources: paths,
            dependencies,
            checks: z
              .object({
                validators: z
                  .array(z.string().regex(/^(?:business:)?[a-zA-Z0-9][\w.-]{0,79}$/))
                  .max(64),
                guards: ids
              })
              .strict(),
            host: z
              .object({
                stage: z
                  .object({
                    actionIds: ids,
                    artifactIds: ids,
                    checkIds: ids,
                    approval: z.enum(["none", "human"])
                  })
                  .strict(),
                actions: z.array(declaration),
                artifacts: z.array(declaration),
                checks: z.array(declaration),
                environment: z.array(declaration)
              })
              .strict()
              .optional(),
            insertAfter: id.optional(),
            userConfig: declaration.optional()
          })
          .strict()
      )
      .max(64),
    extensions: z
      .array(
        z
          .object({
            id,
            title: z.string().min(1).max(160),
            kind: z.literal("function"),
            entry: z.string(),
            resources: paths,
            dependencies,
            usage: z.enum(["universal", "chat", "project"]).optional(),
            actions: z.array(declaration).optional(),
            configSchema: declaration.optional(),
            userConfig: declaration.optional(),
            contextProvider: z
              .object({
                entry: z.string(),
                operations: z
                  .array(z.enum(["session-context", "sync-knowledge"]))
                  .min(1)
                  .max(2),
                knowledgeBinding: z.string().optional(),
                required: z.boolean()
              })
              .strict()
              .optional(),
            skills: paths.optional(),
            stageRecoveryAdapter: z
              .object({
                apiVersion: z.literal("devclaw.plugin-stage-recovery/v1"),
                entry: z.string(),
                runtime: z.literal("python"),
                isolation: z.literal("private-output-copy"),
                codeSource: z.literal("keep"),
                externalEffects: z.literal("network-requires-confirmation")
              })
              .strict()
              .optional()
          })
          .strict()
      )
      .max(32)
      .optional()
  })
  .strict()

export class BusinessModCatalogValidationError extends Error {
  readonly code = "BUSINESS_MOD_CATALOG_INVALID"
  readonly diagnostics: Array<{ path: string; code: string; message: string }>

  constructor(
    diagnostics: BusinessModCatalogValidationError["diagnostics"],
    message = "BUSINESS_MOD_CATALOG_INVALID"
  ) {
    super(message)
    this.diagnostics = diagnostics
  }
}

/** No input values, unknown field names, or source parser fragments enter diagnostics. */
export function assertBusinessModCatalogShape(value: unknown) {
  const serialized = JSON.stringify(value)
  if (serialized && Buffer.byteLength(serialized) > 256 * 1024)
    throw new BusinessModCatalogValidationError([
      { path: "catalog", code: "too_big", message: "Catalog must fit within 256 KiB." }
    ])
  const result = businessModCatalogSchema.safeParse(value)
  if (result.success) return
  throw new BusinessModCatalogValidationError(
    result.error.issues.slice(0, 12).map((issue) => ({
      path: ["catalog", ...issue.path].join("."),
      code: issue.code,
      message:
        issue.code === "unrecognized_keys"
          ? "Remove unsupported fields at this object; read modularization_schema for allowed fields."
          : "Required field has the wrong type, value or size; read modularization_schema."
    }))
  )
}
