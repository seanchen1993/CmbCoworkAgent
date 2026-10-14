import { createAsyncMutex } from "../utils/fs"

/** One main-process catalog writer queue, shared by legacy and creator entry points. */
export const pluginCatalogMutex = createAsyncMutex()

export async function withPluginCatalogMutation<T>(operation: () => Promise<T>): Promise<T> {
  await pluginCatalogMutex.acquire()
  try {
    return await operation()
  } finally {
    pluginCatalogMutex.release()
  }
}
