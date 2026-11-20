declare module "*?nodeWorker" {
  import type { Worker, WorkerOptions } from "node:worker_threads"

  const createWorker: (options?: WorkerOptions) => Worker
  export default createWorker
}
