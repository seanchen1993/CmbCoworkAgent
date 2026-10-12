import { nativeShellPlan } from "./native-shell-contract"
import { z } from "zod"
import type { Writable } from "node:stream"
import {
  botShellProgressSchema,
  botShellRequestSchema,
  botShellResultSchema
} from "./shell-contract"

export const OWNED_SHELL_REQUEST_BYTES = 32 * 1024 * 1024
export const OWNED_SHELL_FRAME_BYTES = 20 * 1024 * 1024
const nonce = z.string().uuid()
const pid = z.number().int().positive().max(0x7fffffff)
const path = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"))
const envelope = { nonce, sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }
export const ownedShellLaunchSchema = z
  .object({
    entry: path,
    entrySha256: z.string().regex(/^[a-f0-9]{64}$/),
    cwd: path,
    /** Trusted worker bootstrap location can differ from a not-yet-created
     * approved Hook copy. It does not change the command's authorized cwd. */
    startupCwd: path.optional(),
    executable: path,
    execArgv: z
      .array(
        z
          .string()
          .max(64_000)
          .refine((value) => !value.includes("\0"))
      )
      .max(32),
    nativePlan: nativeShellPlan.optional(),
    environment: z
      .object({
        TMPDIR: path.optional(),
        TMP: path.optional(),
        TEMP: path.optional(),
        HOME: path.optional(),
        CMB_BOT_COMMAND_SCRATCH: path.optional()
      })
      .strict()
  })
  .strict()
export type OwnedShellLaunch = z.infer<typeof ownedShellLaunchSchema>
export const ownedShellControlSchema = z.discriminatedUnion("type", [
  z.object({ ...envelope, type: z.literal("start"), launch: ownedShellLaunchSchema }).strict(),
  z.object({ ...envelope, type: z.literal("run"), request: botShellRequestSchema }).strict(),
  z.object({ ...envelope, type: z.literal("commit") }).strict(),
  z.object({ ...envelope, type: z.literal("cancel") }).strict(),
  z.object({ ...envelope, type: z.literal("fence") }).strict()
])
export const ownedShellFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...envelope,
      type: z.literal("hello"),
      helperPid: pid,
      token: z.string().regex(/^[a-f0-9]{64}$/)
    })
    .strict(),
  z.object({ ...envelope, type: z.literal("ready"), helperPid: pid, workerPid: pid }).strict(),
  z.object({ ...envelope, type: z.literal("native-probe"), pid }).strict(),
  z.object({ ...envelope, type: z.literal("prepared") }).strict(),
  z.object({ ...envelope, type: z.literal("accepted") }).strict(),
  z.object({ ...envelope, type: z.literal("progress"), value: botShellProgressSchema }).strict(),
  z
    .object({
      ...envelope,
      type: z.literal("candidate"),
      outcome: z.discriminatedUnion("type", [
        z.object({ type: z.literal("result"), value: botShellResultSchema }).strict(),
        z.object({ type: z.literal("error"), message: z.string().min(1).max(2000) }).strict()
      ])
    })
    .strict()
])
export type OwnedShellFrame = z.infer<typeof ownedShellFrameSchema>
export type OwnedShellControl = z.infer<typeof ownedShellControlSchema>

/** One frame allocation, length checked before allocation, and no repeated
 * concatenation of a growing payload. Socket chunk boundaries do not limit
 * the number of complete protocol frames. Malformed streams never allocate beyond
 * the private contract limit. Nothing is interpreted as command output. */
export class OwnedShellDecoder {
  private readonly header = Buffer.allocUnsafe(4)
  private headerOffset = 0
  private payload: Buffer | undefined
  private payloadOffset = 0
  private failed = false
  constructor(
    private readonly limit: number,
    private readonly receive: (value: unknown) => void
  ) {}
  feed(chunk: Buffer): void {
    if (this.failed) throw new Error("Owned shell decoder is closed")
    let offset = 0
    try {
      while (offset < chunk.length) {
        if (!this.payload) {
          const copied = chunk.copy(
            this.header,
            this.headerOffset,
            offset,
            offset + Math.min(4 - this.headerOffset, chunk.length - offset)
          )
          offset += copied
          this.headerOffset += copied
          if (this.headerOffset < 4) return
          const length = this.header.readUInt32BE(0)
          if (length === 0 || length > this.limit)
            throw new Error("Owned shell frame exceeds its limit")
          this.payload = Buffer.allocUnsafe(length)
          this.payloadOffset = 0
        }
        const copied = chunk.copy(
          this.payload,
          this.payloadOffset,
          offset,
          offset + Math.min(this.payload.length - this.payloadOffset, chunk.length - offset)
        )
        offset += copied
        this.payloadOffset += copied
        if (this.payloadOffset < this.payload.length) return
        const value = JSON.parse(this.payload.toString("utf8")) as unknown
        this.payload = undefined
        this.headerOffset = 0
        this.payloadOffset = 0
        this.receive(value)
      }
    } catch (error) {
      this.failed = true
      this.payload = undefined
      throw error
    }
  }
  end(): void {
    if (this.headerOffset !== 0 || this.payload !== undefined)
      throw new Error("Owned shell frame was truncated")
  }
}

interface PendingFrame {
  build(): unknown
  written?: () => void
}
/** One in-flight frame + one control/final + one replaceable progress. Sequence
 * numbers are assigned at write time, so coalescing cannot create wire gaps. */
export class OwnedShellWriter {
  private busy = false
  private closed = false
  private control: PendingFrame | undefined
  private progress: PendingFrame | undefined
  constructor(
    private readonly output: Writable,
    private readonly limit: number,
    private readonly failure: (error: unknown) => void
  ) {}
  send(
    build: () => unknown,
    options: { replaceable?: boolean; written?: () => void; discardProgress?: boolean } = {}
  ): void {
    if (this.closed) return
    if (options.discardProgress) this.progress = undefined
    const frame = { build, written: options.written }
    if (this.busy) {
      if (options.replaceable) this.progress = frame
      else if (this.control) this.fail(new Error("Owned shell control backlog exceeds its limit"))
      else this.control = frame
      return
    }
    this.write(frame)
  }
  private fail(error: unknown): void {
    if (this.closed) return
    this.close()
    this.failure(error)
  }
  private write(frame: PendingFrame): void {
    if (this.closed) return
    this.busy = true
    try {
      const payload = Buffer.from(JSON.stringify(frame.build()))
      if (payload.length === 0 || payload.length > this.limit)
        throw new Error("Owned shell output exceeds its limit")
      const header = Buffer.allocUnsafe(4)
      header.writeUInt32BE(payload.length)
      const bytes = Buffer.concat([header, payload])
      this.output.write(bytes, (error) => {
        if (error) return this.fail(error)
        if (this.closed) return
        this.busy = false
        try {
          frame.written?.()
        } catch (callbackError) {
          return this.fail(callbackError)
        }
        // written() may itself send the next authenticated control frame.
        if (this.busy || this.closed) return
        const next = this.control ?? this.progress
        if (this.control) this.control = undefined
        else this.progress = undefined
        if (next) this.write(next)
      })
    } catch (error) {
      this.fail(error)
    }
  }
  close(): void {
    this.closed = true
    this.progress = undefined
    this.control = undefined
  }
  /** Internal nearest diagnostics; no writable external queue access. */
  retainedFrames(): number {
    return Number(this.busy) + Number(Boolean(this.control)) + Number(Boolean(this.progress))
  }
}
