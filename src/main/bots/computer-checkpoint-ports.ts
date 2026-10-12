import type {
  ComputerComponent,
  ComputerOwnedIdentity,
  ComputerPrepared,
  ComputerSlotName
} from "./computer-checkpoint-manifest"
import type { BotComputerCheckpointSummary } from "../../shared/bot-computer-checkpoint"
import type { BotDirectoryEntry } from "./directory-checkpoint"

export type ComponentName = "data" | "shared" | "browser" | "managed"
export type ComponentLocations = ReadonlyMap<ComputerSlotName, string>
export interface ComputerOwner {
  assertCurrent(): void
  checkCurrent(): Promise<void>
  /** Persisted physical ownership barrier, available before Store/runtime startup. */
  identity(): ComputerOwnedIdentity
}
export type DirectoryState = Extract<ComputerPrepared["originalShared"], { state: "established" }>
export interface ComputerProgress {
  phase: "capture" | "verify" | "prepare" | "replace" | "publish" | "cleanup"
  component: ComponentName
  entries: number
  bytes: number
}
export class ComputerBudget {
  private files = 0
  private bytes = 0
  constructor(
    private readonly capFiles = 50_000,
    private readonly capBytes = 20 * 1024 ** 3
  ) {}
  remaining() {
    return { entries: this.capFiles - this.files, bytes: this.capBytes - this.bytes }
  }
  consume(entries: number, bytes: number) {
    if (
      !Number.isSafeInteger(entries) ||
      !Number.isSafeInteger(bytes) ||
      entries < 0 ||
      bytes < 0 ||
      entries > this.capFiles - this.files ||
      bytes > this.capBytes - this.bytes
    )
      throw new Error("电脑恢复点超过 50000 个条目或 20 GiB 上限，未发布恢复点")
    this.files += entries
    this.bytes += bytes
  }
  totals() {
    return { files: this.files, bytes: this.bytes }
  }
}
export interface ComputerCaptureInput {
  directory: string
  destination: string
  originId: string
  owner: ComputerOwner
  budget: ComputerBudget
  signal: AbortSignal
  progress?: (value: ComputerProgress) => void
}
export interface ComputerPreparationInput {
  directory: string
  pointRoot: string
  hostStage: string
  sharedStage: string
  originId: string
  nonce: string
  owner: ComputerOwner
  signal: AbortSignal
  progress?: (value: ComputerProgress) => void
}
export interface ComputerCaptureOutput {
  components: Record<ComponentName, ComputerComponent>
  managedGit: BotComputerCheckpointSummary["managedGit"]
}
export interface ComputerPorts {
  /** All captures use the immutable DB snapshot, exact source directory second
   * pass, bounded file handles and one global budget. No component is published. */
  capture(input: ComputerCaptureInput): Promise<ComputerCaptureOutput>
  /** Verify complete manifest topology/bytes without opening a live Store. */
  verifyPoint(
    root: string,
    components: ComputerCaptureOutput["components"],
    originId: string
  ): Promise<void>
  /** Copy all next trees, apply acknowledged deletion barriers and fence tasks
   * in the staged DB. Return post-fence checksums, with no current-tree changes. */
  prepare(
    input: ComputerPreparationInput,
    components: ComputerCaptureOutput["components"]
  ): Promise<Omit<ComputerPrepared, "format" | "nonce" | "originId" | "checkpoint" | "slots">>
  /** Checks already-moved and unmoved trees using post-fence digests. */
  verifyPrepared(
    input: ComputerPreparationInput,
    prepared: ComputerPrepared,
    locations: ComponentLocations
  ): Promise<void>
  /** Compare original/new workspace record checksums before publishing its
   * pinned identity, including an explicit absent target. Only owner control
   * state changes; user-selected repositories are never destinations. */
  publishShared(input: ComputerPreparationInput, prepared: ComputerPrepared): Promise<void>
  verifySharedRecord(input: ComputerPreparationInput, prepared: ComputerPrepared): Promise<void>
  /** Managed Git deliverables are verified independent checkouts in a new
   * recovery directory. No old task binding/ref/repository is mutated. */
  publishManaged(input: ComputerPreparationInput, prepared: ComputerPrepared): Promise<void>
}

export const treeBytes = (entries: BotDirectoryEntry[]) =>
  entries.reduce((sum, entry) => sum + (entry.kind === "file" ? entry.size : 0), 0)
