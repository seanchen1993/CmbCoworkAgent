import type { PartnerRequirementResult, PartnerRequirementRun } from "./requirement-execution-types"
import { validatePartnerRun } from "./requirement-execution-types"
import { PartnerLocalFault } from "./partner-local-client"

export interface PartnerWorkerClient {
  observe(): Promise<void>
  poll(): Promise<Array<{ id: string; status: string }>>
  claim(id: string): Promise<PartnerRequirementRun>
  recover?(id: string): Promise<PartnerRequirementRun>
}
export interface PartnerWorkerExecutor {
  execute(run: PartnerRequirementRun): Promise<PartnerRequirementResult>
  cancel(run: PartnerRequirementRun): boolean
}
/** One designated local node, one serial poll and one active graph. No timer
 * survives stop; stopping waits for the actual graph, not just a status flip. */
export class PartnerLocalWorker {
  private generation = 0
  private enabled = false
  private pollTimer?: ReturnType<typeof setTimeout>
  private heartbeatTimer?: ReturnType<typeof setTimeout>
  private pollCompletion?: Promise<void>
  private heartbeatCompletion?: Promise<void>
  private active?: PartnerRequirementRun
  private readonly finished = new Set<string>()
  constructor(
    private readonly deps: {
      client: PartnerWorkerClient
      executor: PartnerWorkerExecutor
      onChange: (value: {
        enabled: boolean
        activeRunId: string | null
        error: string | null
      }) => void
      pollMs?: number
      heartbeatMs?: number
    }
  ) {}
  isEnabled(): boolean {
    return this.enabled
  }
  activeRunId(): string | null {
    return this.active?.id ?? null
  }
  private report(error: string | null = null): void {
    this.deps.onChange({ enabled: this.enabled, activeRunId: this.activeRunId(), error })
  }
  private fail(): void {
    this.enabled = false
    this.generation++
    clearTimeout(this.pollTimer)
    clearTimeout(this.heartbeatTimer)
    if (this.active) this.deps.executor.cancel(this.active)
    this.report("DEPENDENCY_UNAVAILABLE")
  }
  async start(): Promise<void> {
    await this.stop()
    const generation = ++this.generation
    // Explicit caller has already verified all three server identities.
    await this.deps.client.observe()
    if (generation !== this.generation) return
    this.enabled = true
    this.finished.clear()
    this.report()
    this.scheduleHeartbeat(generation)
    this.schedulePoll(generation, 0)
  }
  async stop(): Promise<void> {
    this.enabled = false
    this.generation++
    clearTimeout(this.pollTimer)
    clearTimeout(this.heartbeatTimer)
    if (this.active) this.deps.executor.cancel(this.active)
    await Promise.allSettled([this.pollCompletion, this.heartbeatCompletion].filter(Boolean))
    this.report()
  }
  private current(g: number): boolean {
    return this.enabled && this.generation === g
  }
  private scheduleHeartbeat(g: number): void {
    if (!this.current(g)) return
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatCompletion = this.heartbeat(g)
    }, this.deps.heartbeatMs ?? 15000)
  }
  private async heartbeat(g: number): Promise<void> {
    try {
      await this.deps.client.observe()
      if (this.current(g)) this.scheduleHeartbeat(g)
    } catch {
      if (this.current(g)) this.fail()
    }
  }
  private schedulePoll(g: number, ms = this.deps.pollMs ?? 2000): void {
    if (!this.current(g)) return
    this.pollTimer = setTimeout(() => {
      this.pollCompletion = this.poll(g)
    }, ms)
  }
  private async poll(g: number): Promise<void> {
    try {
      const runs = await this.deps.client.poll()
      for (const item of runs) {
        if (!this.current(g)) break
        if (this.finished.has(item.id)) continue
        const run = validatePartnerRun(
          await (item.status === "running" && this.deps.client.recover
            ? this.deps.client.recover(item.id)
            : this.deps.client.claim(item.id))
        )
        if (!this.current(g)) break // A stopped node never starts a late claim.
        this.active = run
        this.report()
        try {
          await this.deps.executor.execute(run)
          this.finished.add(run.id)
        } catch (error) {
          const code = error instanceof Error ? error.message : ""
          if (code === "PARTNER_MEMORY_CHANGED") {
            this.finished.add(run.id)
            this.report("MEMORY_CHANGED")
          } else if (
            ["PARTNER_EXECUTION_OUTCOME_UNKNOWN", "PARTNER_EXECUTION_LEASE_LOST"].includes(code)
          ) {
            this.finished.add(run.id)
            this.report("OUTCOME_UNKNOWN")
          } else throw error
        } finally {
          this.active = undefined
          this.report()
        }
        if (this.finished.size > 256) {
          this.fail()
          return
        } // bounded; manual restart, never an unbounded history cache
      }
      if (this.current(g)) this.schedulePoll(g)
    } catch (error) {
      if (this.current(g)) {
        this.fail()
        if (error instanceof PartnerLocalFault) this.report(error.code)
      }
    }
  }
}
