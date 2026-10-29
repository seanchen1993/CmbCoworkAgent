import type { z } from "zod"
import { parseProjectRuntimeManifest } from "../../../shared/project-runtime"
import { ProjectSourcePatchError } from "./project-source-patch"
import { validateToolSchema } from "../v2/tool-schema"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { ModObject } from "../../../shared/mods/types"

type AuthorJsonFile =
  | "devclaw.harness.json"
  | "plugin.json"
  | "devclaw.project-runtime.json"
  | "devclaw.project-actions.lock.json"
  | "composition/source.json"

export interface ProjectCompileDiagnostic {
  file: AuthorJsonFile
  /** JSON Pointer into this source file. Empty means the document root. */
  path: string
  code: string
  message: string
}

export class ProjectCompileDiagnosticError extends Error {
  constructor(
    code: string,
    readonly diagnostics: readonly ProjectCompileDiagnostic[]
  ) {
    super(code)
    this.name = "ProjectCompileDiagnosticError"
  }
}

/** Retain the existing patch error/CAS recovery contract while adding safe schema details. */
export class ProjectCompilePatchDiagnosticError extends ProjectSourcePatchError {
  readonly diagnostics: readonly ProjectCompileDiagnostic[]

  constructor(error: ProjectCompileDiagnosticError) {
    super("SCHEMA", undefined, error.diagnostics[0]?.path)
    this.diagnostics = error.diagnostics
  }
}

// Only schema-owned field names and bounded array indexes may cross this boundary.
const fields = new Set([
  "apiVersion",
  "nodes",
  "id",
  "title",
  "skill",
  "artifacts",
  "path",
  "example",
  "schema",
  "approval",
  "name",
  "version",
  "plugin",
  "description",
  "resources",
  "configuration",
  "userConfig",
  "userConfigSchema",
  "context",
  "executionResources",
  "contextAction",
  "provider",
  "actionId",
  "input",
  "config",
  "environment",
  "required",
  "modules",
  "executionMode",
  "inputs",
  "artifactId",
  "contract",
  "outputs",
  "checks",
  "kind",
  "format",
  "maxBytes",
  "bindProviderIdentity",
  "configurationKeys",
  "resultApproval",
  "type"
])
function pointer(segments: readonly PropertyKey[]): string {
  const result: string[] = []
  for (const segment of segments.slice(0, 12)) {
    if (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0)
      result.push(String(segment))
    else if (typeof segment === "string" && fields.has(segment)) result.push(segment)
    else break
  }
  return result.length ? `/${result.join("/")}` : ""
}

/** Parser excerpts, issue messages, unknown keys and input values are deliberately excluded. */
export function projectHarnessSchemaError(issues: readonly z.core.$ZodIssue[]) {
  return projectAuthorSchemaError("devclaw.harness.json", issues, "PROJECT_HARNESS_INVALID")
}

function projectAuthorSchemaError(
  file: AuthorJsonFile,
  issues: readonly z.core.$ZodIssue[],
  code = "PROJECT_AUTHORING_SCHEMA_INVALID"
) {
  const configurationKeysInvalid = (issue: z.core.$ZodIssue) =>
    file === "composition/source.json" &&
    issue.code === "custom" &&
    issue.message === "PROJECT_CHECK_CONFIGURATION_KEYS_INVALID"
  const failureCode = issues.some(configurationKeysInvalid)
    ? "PROJECT_CHECK_CONFIGURATION_KEYS_INVALID"
    : code
  const messages: Record<string, string> = {
    invalid_type: "Field has the wrong type or is missing; use the declared schema type.",
    invalid_value: "Field must match a permitted schema value.",
    invalid_format: "String does not match the required schema format.",
    invalid_union: "Field must match a permitted schema variant.",
    unrecognized_keys: "Object contains unsupported fields; use only declared schema fields.",
    too_small: "Field does not meet the schema minimum length or item count.",
    too_big: "Field exceeds the schema maximum length or item count."
  }
  return new ProjectCompileDiagnosticError(
    failureCode,
    issues.slice(0, 16).map((issue) => ({
      file,
      path: pointer(issue.path),
      code: configurationKeysInvalid(issue)
        ? "PROJECT_CHECK_CONFIGURATION_KEYS_INVALID"
        : Object.hasOwn(messages, issue.code)
          ? `PROJECT_SCHEMA_${issue.code.toUpperCase()}`
          : "PROJECT_SCHEMA_INVALID",
      message: configurationKeysInvalid(issue)
        ? "Selected configuration keys must satisfy the public check configuration-key contract. Preserve its configuration and provider requirements."
        : file === "composition/source.json" &&
            issue.code === "invalid_union" &&
            issue.path.at(-1) === "kind"
          ? "Native check kind must be json-schema or action. Preserve the required artifact validation when repairing this declaration."
          : (messages[issue.code] ?? "Field does not satisfy the authoring schema.")
    }))
  )
}

/** Validate only a known author document. Unrelated exceptions keep their original safe handling. */
export function parseProjectAuthorSchema<T>(
  file: AuthorJsonFile,
  value: unknown,
  schema: z.ZodType<T>
): T {
  let parsed: ReturnType<typeof schema.safeParse>
  try {
    parsed = schema.safeParse(value)
  } catch (error) {
    // Native path transforms use this fixed production rejection instead of a Zod issue.
    if (!(error instanceof Error) || error.message !== "PROJECT_HOST_FILE_PATH_INVALID") throw error
    throw new ProjectCompileDiagnosticError("PROJECT_HOST_FILE_PATH_INVALID", [
      {
        file,
        path: "",
        code: "PROJECT_SCHEMA_PATH_INVALID",
        message:
          "A declared package path is unsafe. Use relative portable paths within the package; the production path validator provides no narrower field location."
      }
    ])
  }
  if (!parsed.success) throw projectAuthorSchemaError(file, parsed.error.issues)
  return parsed.data
}

/** The production schema subset stays authoritative; only fixed author-facing reasons are added. */
export function validateProjectAuthorJsonSchema(
  file: AuthorJsonFile,
  fieldPath: readonly PropertyKey[],
  schema: ModObject
): void {
  const reasons: Record<string, { code: string; message: string }> = {
    MODS_TOOL_SCHEMA: {
      code: "PROJECT_JSON_SCHEMA_INVALID",
      message:
        "Schema must satisfy the bounded Host JSON Schema profile, including keyword value types and the existing schema size limit. Preserve the artifact acceptance requirements when repairing it."
    },
    MODS_TOOL_SCHEMA_UNSUPPORTED: {
      code: "PROJECT_JSON_SCHEMA_UNSUPPORTED_KEYWORD",
      message:
        "Schema contains an unsupported keyword. Express the same requirement with the supported Host schema profile or an actual authorized action check; do not remove the required validation."
    },
    MODS_TOOL_SCHEMA_LIMIT: {
      code: "PROJECT_JSON_SCHEMA_LIMIT",
      message:
        "Schema exceeds the existing Host node or depth budget. Simplify its structure while preserving the required validation."
    },
    MODS_TOOL_SCHEMA_REF: {
      code: "PROJECT_JSON_SCHEMA_REF_INVALID",
      message:
        "Schema references must resolve to supported local $defs or definitions, without external or recursive references. Preserve the required validation."
    },
    MODS_TOOL_SCHEMA_RESERVED: {
      code: "PROJECT_JSON_SCHEMA_RESERVED",
      message:
        "Schema declares a reserved Host field. Repair the declaration using the supported schema profile while preserving the required validation."
    }
  }
  try {
    validateToolSchema(schema, { allowReservedKeys: true })
  } catch (error) {
    if (!(error instanceof ModFunctionError) || !Object.hasOwn(reasons, error.code)) throw error
    const rootTypeInvalid =
      error.code === "MODS_TOOL_SCHEMA" && schema.type !== undefined && schema.type !== "object"
    const reason = rootTypeInvalid
      ? {
          code: "PROJECT_JSON_SCHEMA_ROOT_OBJECT_REQUIRED",
          message:
            "The Host artifact JSON Schema profile requires root type object when type is declared. Keep the nonempty-content requirement: use a validated JSON object containing the text, or an actual authorized action check for a text artifact. Do not silently change the artifact format or remove its checks."
        }
      : reasons[error.code]
    throw new ProjectCompileDiagnosticError(error.code, [
      {
        file,
        path: pointer([...fieldPath, ...(rootTypeInvalid ? ["type"] : [])]),
        ...reason
      }
    ])
  }
}

export function parseProjectAuthorJson(
  file: AuthorJsonFile,
  text: string,
  fieldPath: readonly PropertyKey[] = []
): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new ProjectCompileDiagnosticError("PROJECT_AUTHORING_JSON_INVALID", [
      {
        file,
        path: pointer(fieldPath),
        code: "PROJECT_JSON_SYNTAX",
        message:
          "Source must contain valid JSON; repair its syntax without removing required checks."
      }
    ])
  }
}

/** The retained production parser owns runtime validation; it does not expose field locations. */
export function parseExistingProjectRuntime(value: unknown) {
  try {
    return parseProjectRuntimeManifest(value)
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "PROJECT_RUNTIME_MANIFEST_INVALID")
      throw error
    throw new ProjectCompileDiagnosticError("PROJECT_RUNTIME_MANIFEST_INVALID", [
      {
        file: "devclaw.project-runtime.json",
        path: "",
        code: "PROJECT_RUNTIME_SCHEMA_INVALID",
        message:
          "Existing runtime fails the production schema or reference checks. Read and preserve its action bindings and extension envelope; repair the source without deleting runtime or checks. The parser provides no narrower field location."
      }
    ])
  }
}
