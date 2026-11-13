import { afterAll, vi } from "vitest"

afterAll(async () => {
  // Keep leaf mocks intact; actual import neither creates nor replaces the lazy default client.
  const actual = await vi.importActual<{ closeCheckpointRuntimeProjectionWorker(): Promise<void> }>(
    "../../src/main/checkpointer/runtime-projection-client"
  )
  await actual.closeCheckpointRuntimeProjectionWorker()
})
