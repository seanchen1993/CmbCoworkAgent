import { Buffer } from "node:buffer"
import { isAbsolute } from "node:path"

export const WINDOWS_BOT_RESOURCE_INPUT_BYTES = 64 * 1024
export interface WindowsBotResourceRequest {
  executable: string
  cwd: string
  receiptDirectory: string
  jobName: string
  args: string[]
  limits: { pids: number; memoryBytes: number }
  bootId: string
  sessionId: number
  timeoutMs: number
  /** Trusted immutable identity projection. The native writer publishes these
   * bytes only after querying its actual unique Job handle as empty. */
  proof: unknown
}
export function encodeWindowsBotResourceRequest(input: WindowsBotResourceRequest): Buffer {
  return encodeRequest(input, 7_245_000)
}
/** Trusted native desktop launcher only; the native computer entry separately
 * enforces this one-day upper bound. A deadline is not a closure proof. */
export function encodeWindowsDesktopResourceRequest(input: WindowsBotResourceRequest): Buffer {
  return encodeRequest(input, 86_400_000)
}
function encodeRequest(input: WindowsBotResourceRequest, maximumTimeoutMs: number): Buffer {
  if (
    ![input.executable, input.cwd, input.receiptDirectory].every(
      (value) =>
        isAbsolute(value) && Buffer.byteLength(value, "utf8") <= 4096 && !value.includes("\0")
    )
  )
    throw new Error("Invalid native resource paths")
  if (
    input.args.length > 16 ||
    input.args.some((value) => Buffer.byteLength(value, "utf8") > 4096 || value.includes("\0"))
  )
    throw new Error("Invalid native bootstrap arguments")
  const parts: Buffer[] = []
  const number = (value: number) => {
    const bytes = Buffer.allocUnsafe(4)
    bytes.writeUInt32BE(value)
    parts.push(bytes)
  }
  const bytes = (value: Buffer) => {
    number(value.length)
    parts.push(value)
  }
  const string = (value: string) => bytes(Buffer.from(value, "utf8"))
  string("CMBBOTJOB2")
  string(input.executable)
  string(input.cwd)
  string(input.receiptDirectory)
  if (
    !/^Local\\CMBDevClaw-Bot-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      input.jobName
    )
  )
    throw new Error("Invalid Bot Job identity")
  string(input.jobName)
  number(input.args.length)
  for (const value of input.args) string(value)
  if (
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs < 1000 ||
    input.timeoutMs > maximumTimeoutMs
  )
    throw new Error("Invalid native resource deadline")
  if (
    !Number.isInteger(input.limits.pids) ||
    input.limits.pids < 16 ||
    input.limits.pids > 4096 ||
    !Number.isInteger(input.limits.memoryBytes) ||
    input.limits.memoryBytes < 256 * 1024 * 1024 ||
    input.limits.memoryBytes > 16 * 1024 * 1024 * 1024
  )
    throw new Error("Native Job limits exceed bounds")
  number(input.limits.pids)
  number(Math.floor(input.limits.memoryBytes / 0x100000000))
  number(input.limits.memoryBytes % 0x100000000)
  if (
    !/^[a-f0-9-]{36}$/.test(input.bootId) ||
    !Number.isInteger(input.sessionId) ||
    input.sessionId < 0 ||
    input.sessionId > 0xffffffff
  )
    throw new Error("Invalid native boot/session binding")
  string(input.bootId)
  number(input.sessionId)
  number(input.timeoutMs)
  const proof = Buffer.from(JSON.stringify(input.proof), "utf8")
  if (!proof.length || proof.length > 32 * 1024)
    throw new Error("Native closure proof exceeds bound")
  bytes(proof)
  const size = parts.reduce((total, part) => total + part.length, 0)
  if (size > WINDOWS_BOT_RESOURCE_INPUT_BYTES)
    throw new Error("Native resource request exceeds bound")
  const header = Buffer.allocUnsafe(4)
  header.writeUInt32BE(size)
  return Buffer.concat([header, ...parts], size + 4)
}

export function encodeWindowsBotResourceControl(
  input:
    | { operation: "member"; sequence: number; pid: number }
    | { operation: "stop"; sequence: number }
): Buffer {
  return encodeControl(input, 64)
}
export function encodeWindowsDesktopResourceControl(
  input:
    | { operation: "member"; sequence: number; pid: number }
    | { operation: "stop"; sequence: number }
): Buffer {
  return encodeControl(input, 4096)
}
function encodeControl(
  input:
    | { operation: "member"; sequence: number; pid: number }
    | { operation: "stop"; sequence: number },
  maximumControls: number
): Buffer {
  if (!Number.isInteger(input.sequence) || input.sequence < 1 || input.sequence > maximumControls)
    throw new Error("Native control order exceeds bounds")
  const pid = input.operation === "member" ? input.pid : 0
  if (
    !Number.isInteger(pid) ||
    pid < 0 ||
    pid > 0x7fffffff ||
    (input.operation === "member" && pid === 0)
  )
    throw new Error("Native member PID is invalid")
  const bytes = Buffer.allocUnsafe(16)
  bytes.writeUInt32BE(12, 0)
  bytes.writeUInt32BE(input.operation === "member" ? 1 : 2, 4)
  bytes.writeUInt32BE(input.sequence, 8)
  bytes.writeUInt32BE(pid, 12)
  return bytes
}
