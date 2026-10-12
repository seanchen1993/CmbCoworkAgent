import { memo, useMemo } from "react"
import { useShallow } from "zustand/react/shallow"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import { AgentAvatar, type AgentAvatarProps } from "./upstream/grok-agent-avatar"
import { useBotAvatarImages } from "@/lib/use-bot-avatar-images"

/** Keep persona identities and animation nodes stable across Host snapshots. */
export const BotAvatar = memo(function BotAvatar(props: AgentAvatarProps) {
  const images = useBotAvatarImages(
    props.kind === "group" ? (props.memberIds ?? []).slice(0, 4) : [props.agentId]
  )
  // Subscribe only to appearance primitives; streaming snapshots do not restart animation nodes.
  const identities = useBotWorkspaceStore(
    useShallow((state) => {
      const ids = props.kind === "group" ? (props.memberIds ?? []) : [props.agentId]
      return ids.flatMap((id) => {
        const bot = state.snapshot?.bots.find((item) => item.id === id)
        return [id, bot?.avatarShape ?? null, bot?.avatarColor ?? null]
      })
    })
  )
  const members = useMemo(() => {
    const result: Record<
      string,
      { shape: string | null; color: string | null; dataUrl?: string | null }
    > = {}
    for (let index = 0; index < identities.length; index += 3) {
      result[identities[index]!] = {
        shape: identities[index + 1],
        color: identities[index + 2],
        dataUrl: images[identities[index]!]
      }
    }
    return result
  }, [identities, images])
  return (
    <AgentAvatar
      {...props}
      dataUrl={props.dataUrl !== undefined ? props.dataUrl : images[props.agentId]}
      shape={props.shape !== undefined ? props.shape : members[props.agentId]?.shape}
      color={props.color !== undefined ? props.color : members[props.agentId]?.color}
      memberPersonas={props.memberPersonas ?? members}
    />
  )
})
