import { summarizeSamples } from "./mods-v2-performance"

/** Diagnostic instrumentation only. Instrumented runs cannot qualify as acceptance results. */
export class IngressCostProfile {
  private readonly values = new Map<string, number[]>()
  private paused = false

  constructor(private readonly clock: () => number = () => performance.now()) {}

  measure<T>(name: string, call: () => T): T {
    if (this.paused) return call()
    const start = this.clock()
    try {
      return call()
    } finally {
      const values = this.values.get(name) ?? []
      values.push(this.clock() - start)
      this.values.set(name, values)
    }
  }

  async measureAsync<T>(name: string, call: () => Promise<T>): Promise<T> {
    if (this.paused) return call()
    const start = this.clock()
    try {
      return await call()
    } finally {
      const values = this.values.get(name) ?? []
      values.push(this.clock() - start)
      this.values.set(name, values)
    }
  }

  pause(): void {
    this.paused = true
  }

  reset(): void {
    this.values.clear()
    this.paused = false
  }

  snapshot(): Record<
    string,
    { calls: number; totalMs: number; meanMs: number; p95Ms: number; maxMs: number }
  > {
    return Object.fromEntries(
      [...this.values].map(([name, values]) => {
        const totalMs = values.reduce((sum, value) => sum + value, 0)
        const { p95Ms, maxMs } = summarizeSamples(values)
        return [
          name,
          { calls: values.length, totalMs, meanMs: totalMs / values.length, p95Ms, maxMs }
        ]
      })
    )
  }
}
