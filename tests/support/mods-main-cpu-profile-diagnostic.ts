import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import type { Profiler } from "node:inspector"
import { join } from "node:path"
import type { ElectronApplication } from "playwright"

type DiagnosticPhase = "start" | "stop" | "profile-write" | "disconnect" | "delete"
type DiagnosticResult = {
  phase: DiagnosticPhase
  status: "complete" | "failed" | "skipped"
}

export async function withModsMainCpuProfile<T>(
  app: ElectronApplication,
  artifacts: string,
  body: () => Promise<T>
): Promise<T> {
  if (process.env.CMB_MODS_E2E_MAIN_CPU_PROFILE !== "1") return body()

  const key = `cmb-mods-e2e-main-cpu-profile:${randomUUID()}`
  const phases: DiagnosticResult[] = []
  let profile: Profiler.Profile | undefined
  const attempt = async (phase: DiagnosticPhase, operation: () => Promise<void>): Promise<void> => {
    try {
      await operation()
      phases.push({ phase, status: "complete" })
    } catch {
      // Infrastructure diagnostics never replace the original test result or expose its error.
      phases.push({ phase, status: "failed" })
    }
  }

  await attempt("start", async () => {
    await app.evaluate(async (_electron, symbolKey) => {
      const inspector = process.getBuiltinModule("node:inspector")
      const session = new inspector.Session()
      if (!Reflect.set(globalThis, Symbol.for(symbolKey), session)) {
        throw new Error("Main CPU profiler storage unavailable")
      }
      session.connect()
      await new Promise<void>((resolve, reject) => {
        session.post("Profiler.enable", (error) => (error ? reject(error) : resolve()))
      })
      await new Promise<void>((resolve, reject) => {
        session.post("Profiler.start", (error) => (error ? reject(error) : resolve()))
      })
    }, key)
  })

  try {
    return await body()
  } finally {
    await attempt("stop", async () => {
      profile = await app.evaluate(async (_electron, symbolKey) => {
        const inspector = process.getBuiltinModule("node:inspector")
        const session: unknown = Reflect.get(globalThis, Symbol.for(symbolKey))
        if (!(session instanceof inspector.Session)) {
          throw new Error("Main CPU profiler session unavailable")
        }
        return new Promise<Profiler.Profile>((resolve, reject) => {
          session.post("Profiler.stop", (error, result) =>
            error ? reject(error) : resolve(result.profile)
          )
        })
      }, key)
    })
    if (profile) {
      await attempt("profile-write", async () => {
        await writeFile(join(artifacts, "main.cpuprofile"), JSON.stringify(profile), "utf8")
      })
    } else {
      phases.push({ phase: "profile-write", status: "skipped" })
    }
    await attempt("disconnect", async () => {
      await app.evaluate((_electron, symbolKey) => {
        const inspector = process.getBuiltinModule("node:inspector")
        const session: unknown = Reflect.get(globalThis, Symbol.for(symbolKey))
        if (!(session instanceof inspector.Session)) {
          throw new Error("Main CPU profiler session unavailable")
        }
        session.disconnect()
      }, key)
    })
    await attempt("delete", async () => {
      await app.evaluate((_electron, symbolKey) => {
        if (!Reflect.deleteProperty(globalThis, Symbol.for(symbolKey))) {
          throw new Error("Main CPU profiler storage cleanup failed")
        }
      }, key)
    })
    try {
      await writeFile(
        join(artifacts, "main-cpu-profile-diagnostic.json"),
        JSON.stringify({ enabled: true, phases }, null, 2),
        "utf8"
      )
    } catch {
      try {
        console.warn("Main CPU profile diagnostic metadata could not be saved")
      } catch {
        // Even a logging failure must preserve the original test result.
      }
    }
  }
}
