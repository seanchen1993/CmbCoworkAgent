import { botApi } from "@/lib/bot-api"
import { useEffect, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { useBotWorkspaceStore } from "./bot-workspace-store"

const cache = new Map<string, Promise<string | null>>()
function read(botId: string, hash: string, epoch: string): Promise<string | null> {
  const key = JSON.stringify([epoch, botId, hash])
  let value = cache.get(key)
  if (!value) {
    value = botApi
      .avatar({ botId, hash })
      .then((png) => (png ? `data:image/png;base64,${png}` : null))
      .catch((error) => {
        cache.delete(key)
        throw error
      })
    cache.set(key, value)
    // Images never travel in frequent workspace snapshots. Bound the shared view cache.
    if (cache.size > 64) cache.delete(cache.keys().next().value!)
  }
  return value
}

export function useBotAvatarImages(ids: readonly string[]): Record<string, string | null> {
  const identities = useBotWorkspaceStore(
    useShallow((state) => [
      state.snapshot?.dataEpoch ?? "initial",
      ...ids.flatMap((id) => [
        id,
        state.snapshot?.bots.find((bot) => bot.id === id)?.avatarHash ?? ""
      ])
    ])
  )
  const identity = JSON.stringify(identities)
  const [view, setView] = useState<{ identity: string; images: Record<string, string | null> }>({
    identity: "",
    images: {}
  })
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      const images: Record<string, string | null> = {}
      let failed = false
      await Promise.all(
        identities
          .slice(1)
          .filter((_, index) => index % 2 === 0)
          .map(async (id, index) => {
            const hash = identities[index * 2 + 2]
            try {
              images[id] = hash ? await read(id, hash, identities[0]) : null
            } catch {
              failed = true
              images[id] = null
            }
          })
      )
      if (!disposed) {
        setView({ identity, images })
        if (failed) timer = setTimeout(() => void load(), 5000)
      }
    }
    void load()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [identity, identities])
  return view.identity === identity ? view.images : {}
}
