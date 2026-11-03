import type * as Esbuild from "esbuild"

type NativeCompiler = Pick<typeof Esbuild, "version" | "build" | "transform" | "stop">
export type ModCompiler = Omit<NativeCompiler, "stop">

/** Compilation is lazy and asynchronous; an idle compiler must not remain a resident child. */
export function createModCompilerService(
  load: () => NativeCompiler,
  idleMs = 30_000
): ModCompiler {
  let native: NativeCompiler | undefined
  let active = 0
  let idle: ReturnType<typeof setTimeout> | undefined
  let stopping: Promise<void> | undefined
  const compiler = () => native ??= load()

  async function run<T>(operation: (service: NativeCompiler) => Promise<T>): Promise<T> {
    active++
    clearTimeout(idle)
    idle = undefined
    try {
      if (stopping) await stopping
      return await operation(compiler())
    } finally {
      if (--active === 0 && native) {
        idle = setTimeout(() => {
          idle = undefined
          if (active || !native) return
          stopping = (async () => {
            try { await native.stop() }
            catch { console.warn("[ModsCompiler] Idle compiler cleanup failed") }
          })().finally(() => { stopping = undefined })
        }, idleMs)
        idle.unref()
      }
    }
  }

  return {
    get version() { return compiler().version },
    build: options => run(service => service.build(options)),
    transform: (input, options) => run(service => service.transform(input, options))
  }
}
