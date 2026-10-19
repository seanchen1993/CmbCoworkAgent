import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"
import { writeFileSync } from "node:fs"
import type { Page } from "playwright"

export type Phase =
  | "setup"
  | "directory-binding"
  | "source-authority"
  | "configure-save"
  | "apply-other-chat"
  | "real-effect"
  | "verification"

export class MeasurementLedger {
  private phase: Phase = "setup"
  private started = performance.now()
  private cellId = "common-setup"
  private clicks: unknown[] = []
  readonly phases: Array<{
    cellId: string
    phase: Phase
    startedAt: number
    wallStartedAt: number
    endedAt?: number
    wallEndedAt?: number
    elapsedMs?: number
  }> = []
  readonly requests: Array<Record<string, unknown>> = []
  readonly native: Array<Record<string, unknown>> = []
  readonly snapshots: Array<Record<string, unknown>> = []
  readonly repairs: Array<Record<string, unknown>> = []
  readonly toolRequests: Array<Record<string, unknown>> = []
  readonly clarifications: Array<Record<string, unknown>> = []

  constructor(readonly id: string) {
    this.begin("setup")
  }

  begin(phase: Phase) {
    this.end()
    this.phase = phase
    this.started = performance.now()
    this.phases.push({
      cellId: this.cellId,
      phase,
      startedAt: this.started,
      wallStartedAt: Date.now()
    })
  }

  selectCell(id: string) {
    this.cellId = id
  }

  recordNative(kind: string, value: Record<string, unknown>) {
    this.native.push({ cellId: this.cellId, phase: this.phase, kind, at: Date.now(), ...value })
  }

  end() {
    const row = this.phases.at(-1)
    if (row && row.endedAt === undefined) {
      row.endedAt = performance.now()
      row.wallEndedAt = Date.now()
      row.elapsedMs = row.endedAt - row.startedAt
    }
  }

  acceptHttp(body: unknown) {
    const row: Record<string, unknown> = {
      id: `${this.id}:http:${this.requests.length + 1}`,
      phase: this.phase,
      cellId: this.cellId,
      acceptedAt: performance.now(),
      body,
      provider: "controlled-loopback",
      usageCoverage: "unknown",
      cost: { status: "unknown", reason: "No actual vendor usage or trusted price" }
    }
    this.requests.push(row)
    return row
  }

  async observe(page: Page) {
    // Native trusted event observations only. This does not mutate product state.
    await page.evaluate(`(() => {
      if (window.__experienceClicks) return
      window.__experienceClicks = []
      document.addEventListener('click', event => {
        const element = event.composedPath().find(value => value instanceof Element &&
          value.matches('button,input[type=checkbox],input[type=radio],summary'))
        if (!element) return
        window.__experienceClicks.push({at:performance.now(),wallAt:Date.now(),trusted:event.isTrusted,
          tag:element.tagName, role:element.getAttribute('role'),
          label:element.getAttribute('aria-label') || element.textContent?.trim(),
          phase:window.__experiencePhase || 'setup',cellId:window.__experienceCell})
      }, true)
    })()`)
    await page.evaluate(`(() => { window.__experienceCell = ${JSON.stringify(this.cellId)} })()`)
  }

  async drain(page: Page) {
    const rows = await page.evaluate<unknown[]>(`(() => {
      const rows = window.__experienceClicks || []
      window.__experienceClicks = []
      return rows
    })()`)
    assert(Array.isArray(rows), "Original click observer must return its actual event array")
    this.clicks.push(...rows)
  }

  async mark(page: Page, phase: Phase) {
    this.begin(phase)
    await page.evaluate(`(() => { window.__experiencePhase = ${JSON.stringify(phase)} })()`)
  }

  async finish(page: Page, path: string, outcome: Record<string, unknown>) {
    this.end()
    await this.drain(page)
    writeFileSync(
      path,
      JSON.stringify(
        {
          schema: "current-version-experience-measurement/v1",
          id: this.id,
          outcome,
          phases: this.phases,
          clicks: this.clicks,
          requests: this.requests,
          toolRequests: this.toolRequests,
          native: this.native,
          snapshots: this.snapshots,
          repairs: this.repairs,
          clarifications: this.clarifications,
          definitions: {
            comparison: "Same current binary, not historical S0 or a causal population estimate",
            setup:
              "Prepared implementation, model/account and installation are explicit common prerequisites",
            clicks:
              "Actual event.isTrusted; native bounded-harness decisions are separate, not human clicks",
            questions:
              "Only original request_user_input question items with corresponding actual UI evidence",
            logicalModels: "Original optimizer protected trace modelCalls, not HTTP count",
            tools:
              "Requested trace nodes, public observations and successful native results remain distinct",
            repairs:
              "Every failed cell remains failed; reruns require a new run and count repair cost",
            cost: "Unknown amount omitted; controlled loopback usage is not real vendor spending"
          }
        },
        null,
        2
      )
    )
  }
}

export async function bounded<T>(
  read: () => Promise<T>,
  test: (value: T) => boolean,
  label: string,
  milliseconds = 30_000
): Promise<T> {
  const deadline = performance.now() + milliseconds
  while (performance.now() < deadline) {
    const value = await read()
    if (test(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail(`Timed out: ${label}`)
}
