/** Latest-intent-wins gate for async UI requests that can finish out of order. */
export class LatestRequestGate {
  private readonly latestByKey = new Map<string, number>()
  private nextGeneration = 0

  begin(key: string): number {
    this.nextGeneration += 1
    const generation = this.nextGeneration
    this.latestByKey.set(key, generation)
    return generation
  }

  isCurrent(key: string, generation: number): boolean {
    return this.latestByKey.get(key) === generation
  }

  finish(key: string, generation: number): void {
    if (this.isCurrent(key, generation)) this.latestByKey.delete(key)
  }

  get retainedKeyCount(): number {
    return this.latestByKey.size
  }
}
