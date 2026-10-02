import { readFile } from "node:fs/promises"

export function requireNode22() {
  if (Number(process.versions.node.split(".")[0]) !== 22)
    throw new Error("Dev orchestration requires Node 22; no runtime fallback")
}

export function validateConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid dev config")
  if (Object.keys(value).some((key) => !["profile", "host", "s3", "es"].includes(key))) throw new Error("Unknown dev config field")
  if (value.profile !== "dev") throw new Error("Explicit dev profile required")
  if (value.host !== "127.0.0.1") throw new Error("Only literal 127.0.0.1 is allowed")
  if (value.s3 !== "disabled" || value.es !== "disabled") throw new Error("Real S3/ES must be disabled")
  return Object.freeze({ ...value })
}

export async function configFromOptions(options) {
  const config = options.config
    ? JSON.parse(await readFile(options.config, "utf8"))
    : { profile: options.profile, host: "127.0.0.1", s3: "disabled", es: "disabled" }
  if (options.profile !== undefined && options.profile !== config.profile) throw new Error("Conflicting profile")
  return validateConfig(config)
}

export function parseArgs(args) {
  const [command, ...rest] = args
  if (!["doctor", "mock", "real", "check", "serve"].includes(command)) throw new Error("Use doctor|mock|real|check|serve")
  const allowed = ["profile", "config", "java", "javac", "mysql", "mysqld", "jdbc", "maven", "lifetime-ms"]
  const options = {}
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]?.slice(2)
    if (!rest[i]?.startsWith("--") || !allowed.includes(key) || Object.hasOwn(options, key) || !rest[i + 1] || rest[i + 1].startsWith("--"))
      throw new Error("Invalid, duplicate or missing CLI option")
    options[key] = rest[i + 1]
  }
  return { command, options }
}
