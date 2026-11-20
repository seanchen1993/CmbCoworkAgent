import { useEffect, useState, useSyncExternalStore } from "react"
import { createElectronStream, type ElectronStreamOptions } from "./electron-stream"

export function useElectronStream(options: ElectronStreamOptions) {
  const [stream] = useState(() => createElectronStream(options))
  useEffect(() => {
    stream.setCallbacks(options)
  }, [options, stream])
  useSyncExternalStore(stream.subscribe, stream.getSnapshot, stream.getSnapshot)
  // ThreadStreamHolder is keyed by thread ID and retains live holders on navigation.
  // Do not abort its consumer on a React error; the agent can still finish/persist.
  return { ...stream }
}
