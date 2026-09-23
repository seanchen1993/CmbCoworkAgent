export interface PerformanceOptions {
  smoke: boolean
  phase: "all" | "matrix" | "idle" | "soak"
  rounds: number
  samples: number
  warmups: number
  idleSeconds: number
  soakSeconds: number
  soakEvents: number
}

export function parsePerformanceOptions(args: string[]): PerformanceOptions {
  const smoke = args.includes("--smoke")
  const options: PerformanceOptions = {
    smoke,
    phase: "all",
    rounds: smoke ? 1 : 5,
    samples: smoke ? 10 : 1000,
    warmups: smoke ? 3 : 100,
    idleSeconds: smoke ? 1 : 300,
    soakSeconds: smoke ? 3 : 7200,
    soakEvents: smoke ? 20 : 10000
  }
  const numeric = {
    rounds: ["rounds", 1, 10],
    samples: ["samples", 1, 10000],
    warmups: ["warmups", 0, 1000],
    "idle-seconds": ["idleSeconds", 1, 3600],
    "soak-seconds": ["soakSeconds", 1, 14400],
    "soak-events": ["soakEvents", 1, 1000000]
  } as const
  const seen = new Set<string>()
  for (const argument of args) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argument)
    if (!match || seen.has(match[1])) throw Error(`Invalid/duplicate argument: ${argument}`)
    const [, key, value] = match
    seen.add(key)
    if (key === "smoke" && value === undefined) continue
    if (key === "phase" && ["all", "matrix", "idle", "soak"].includes(value)) {
      options.phase = value as PerformanceOptions["phase"]
      continue
    }
    const rule = Object.hasOwn(numeric, key) ? numeric[key as keyof typeof numeric] : undefined
    const number = Number(value)
    if (
      !rule ||
      !/^\d+$/.test(value ?? "") ||
      !Number.isSafeInteger(number) ||
      number < rule[1] ||
      number > rule[2]
    )
      throw Error(`Invalid performance argument: ${argument}`)
    options[rule[0]] = number
  }
  return options
}

export function summarizeSamples(values: number[]) {
  if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0))
    throw Error("Invalid timing samples")
  const sorted = [...values].sort((a, b) => a - b)
  return {
    count: sorted.length,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    minMs: sorted[0],
    maxMs: sorted.at(-1)!
  }
}

export function qualifiesPerformanceRun(options: PerformanceOptions): boolean {
  return (
    !options.smoke &&
    options.phase === "all" &&
    options.rounds >= 5 &&
    options.samples >= 1000 &&
    options.warmups >= 100 &&
    options.idleSeconds >= 300 &&
    options.soakSeconds >= 7200 &&
    options.soakEvents >= 10000
  )
}
