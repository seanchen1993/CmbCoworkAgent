import { z } from "zod"

export const CMBDEVCLAW_SKILL_DEPENDENCY_SCHEMA_VERSION = 1
export const SKILL_DEPENDENCY_MAX_CHECKS = 32
export const SKILL_DEPENDENCY_MAX_BYTES = 8 * 1024

const id = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/)
const executableName = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/)
const environmentName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
const minimumVersion = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})\.(?:0|[1-9][0-9]{0,8})$/)
const platform = z.enum(["darwin", "win32", "linux"])
const reason = z.string().min(1).max(240)

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

/** One canonical spelling on every supported host. A declaration is a project
 * relative requirement, never a grant to read an arbitrary local path. */
function portableProjectPath(value: string): boolean {
  if (value.startsWith("/") || value.includes("\\")) return false
  return value.split("/").every(
    (segment) =>
      Boolean(segment) &&
      segment !== "." &&
      segment !== ".." &&
      // eslint-disable-next-line no-control-regex
      !/[<>:"|?*\x00-\x1f\x7f]/.test(segment) &&
      !/[. ]$/.test(segment) &&
      !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(segment)
  )
}

export const skillDependencyCheck = z.discriminatedUnion("kind", [
  z
    .object({
      id,
      kind: z.literal("platform"),
      platforms: z.array(platform).min(1).max(3).refine(unique, "重复的平台")
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal("executable"),
      name: executableName,
      minimumVersion: minimumVersion.optional()
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal("any-executable"),
      names: z.array(executableName).min(1).max(16).refine(unique, "重复的可执行程序")
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal("file"),
      path: z.string().min(1).max(512).refine(portableProjectPath, "需要跨平台项目相对路径"),
      type: z.enum(["file", "directory"])
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal("environment"),
      name: environmentName
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal("unsupported"),
      label: z.string().min(1).max(120),
      reason
    })
    .strict()
])

export type SkillDependencyCheck = z.infer<typeof skillDependencyCheck>

export const skillDependencyDeclaration = z
  .object({
    source: z.enum(["cmbdevclaw", "openclaw", "mixed", "none"]),
    state: z.enum(["structured", "absent", "unstructured", "invalid"]),
    checks: z.array(skillDependencyCheck).max(SKILL_DEPENDENCY_MAX_CHECKS),
    reason: reason.optional()
  })
  .strict()
  .superRefine((declaration, context) => {
    if (!unique(declaration.checks.map((check) => check.id))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["checks"],
        message: "依赖检查 ID 重复"
      })
    }
    if (declaration.state === "structured") {
      if (!declaration.checks.length || declaration.source === "none") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "结构化声明必须包含明确要求及来源"
        })
      }
    } else if (declaration.checks.length || !declaration.reason) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "未核验声明需要原因且不能包含有效检查"
      })
    }
    if (
      new TextEncoder().encode(JSON.stringify(declaration)).byteLength > SKILL_DEPENDENCY_MAX_BYTES
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "依赖声明超过 8 KiB"
      })
    }
  })

export type SkillDependencyDeclaration = z.infer<typeof skillDependencyDeclaration>
