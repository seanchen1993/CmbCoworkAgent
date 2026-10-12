import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { botApi } from "@/lib/bot-api"
import { useBotSettingsSave } from "@/lib/use-bot-settings-save"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import {
  localToolAnswerPending,
  localToolRecoveryRecord,
  discardRetiredLocalToolRecord,
  pendingLocalToolAnswers,
  type LocalToolAnswerSave
} from "@/lib/bot-local-tool-permission-pending"
import type { BotInteraction } from "../../../../shared/bot-types"
import type { BotLocalToolPolicy } from "../../../../shared/bot-local-tool-permission"
import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"

export function BotLocalToolAnswerRecovery() {
  const [revision, setRevision] = useState(0),
    [selected, setSelected] = useState("")
  const inventory = useMemo<{ ids: string[]; error: string | null }>(() => {
    try {
      return { ids: pendingLocalToolAnswers(), error: null }
    } catch (error) {
      return { ids: [], error: error instanceof Error ? error.message : "读取待确认许可回答失败" }
    }
    // Browser storage is external; explicit ACK/archive refreshes this lightweight inventory.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])
  const id = inventory.ids.includes(selected) ? selected : inventory.ids[0]
  if (!id && !inventory.error) return null
  return (
    <section
      aria-label="待核对的本机许可回答"
      className="space-y-3 rounded-xl border bg-muted/20 p-3"
    >
      <div>
        <h3 className="text-sm font-medium">
          待核对许可回答{inventory.ids.length ? ` · ${inventory.ids.length}` : ""}
        </h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          原卡片可能已从待办中移除。这里仅核对原请求，不创建新许可或任务。
        </p>
      </div>
      {inventory.error && (
        <p role="alert" className="text-xs text-destructive">
          {inventory.error}
        </p>
      )}
      {id && (
        <>
          <label className="block space-y-1 text-xs text-muted-foreground">
            选择原回答
            <select
              aria-label="选择待核对许可回答"
              value={id}
              onChange={(event) => setSelected(event.target.value)}
              className="w-full rounded-lg border bg-background px-3 py-2 text-xs text-foreground"
            >
              {inventory.ids.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <OriginalLocalToolAnswer
            key={id}
            id={id}
            cleared={() => setRevision((value) => value + 1)}
          />
        </>
      )}
    </section>
  )
}
function OriginalLocalToolAnswer({ id, cleared }: { id: string; cleared(): void }) {
  const pending = useMemo(() => localToolAnswerPending(id), [id])
  const lifetime = useRef({ mounted: true })
  useLayoutEffect(() => {
    const owner = lifetime.current
    owner.mounted = true
    return () => {
      owner.mounted = false
    }
  }, [])

  const session = useBotSettingsSave<
    LocalToolAnswerSave,
    BotLocalToolPolicy & { botId: null },
    BotInteraction
  >({
    botId: null,
    pending,
    read: async () => ({ ...(await botApi.localToolPermission()), botId: null }),
    change: ({ botId, ...input }) => {
      void botId
      return botApi.resolveLocalToolPermission(input)
    },
    verifies: (input, receipt) =>
      receipt.id === input.id &&
      receipt.localProjectAccess?.target.id === input.targetId &&
      receipt.localProjectAccess.dataEpoch === input.dataEpoch &&
      receipt.revision === input.revision + 1 &&
      receipt.status === "answered" &&
      receipt.answer ===
        (input.resolution === "always" || input.resolution === "allow-once" ? "approve" : "reject"),
    rejectedCodes: ["stale_interaction", "local_permission_missing", "local_permission_denied"],
    retiredCodes: ["local_computer_changed"]
  })
  const { load } = session
  useEffect(() => {
    void load()
  }, [load])
  const record = localToolRecoveryRecord(session.record, session.value?.target.id)
  const original = record.kind === "valid" || record.kind === "obsolete" ? record.input : null
  const labels = {
    "allow-once": "本次允许",
    deny: "拒绝本次",
    always: "始终允许",
    never: "禁止本机项目访问"
  }
  return (
    <div className="space-y-2">
      {original && (
        <p className="text-xs leading-5 text-muted-foreground">
          原回答：{labels[original.resolution]} ·{" "}
          {session.value?.target.id === original.targetId
            ? session.value.target.label
            : "原执行电脑"}
        </p>
      )}
      {session.error && (
        <p role="alert" className="text-xs text-destructive">
          {session.error}
        </p>
      )}
      {session.restored && (
        <p role="alert" className="text-xs text-destructive">
          电脑或工作区已变化，请重新打开并核对原记录。
        </p>
      )}
      {record.kind !== "empty" && record.kind !== "valid" ? (
        <BotPendingSaveRecovery
          operationLabel="本机许可回答"
          record={record}
          obsoleteTitle={
            session.record.kind === "valid" && record.kind === "obsolete"
              ? "执行电脑已变化，原许可记录仍保留"
              : undefined
          }
          dataEpoch={session.epoch}
          discard={(raw) =>
            useBotWorkspaceStore.getState().snapshot?.dataEpoch === session.epoch &&
            discardRetiredLocalToolRecord(pending, session.epoch, session.value?.target.id, raw)
          }
          onRepaired={cleared}
        />
      ) : (
        record.kind === "valid" && (
          <Button
            size="sm"
            variant="outline"
            disabled={session.saveDisabled}
            onClick={() => {
              void session.save().then((succeeded) => {
                if (
                  lifetime.current.mounted &&
                  useBotWorkspaceStore.getState().snapshot?.dataEpoch === session.epoch &&
                  (succeeded || pending.inspect(null, session.epoch).kind === "empty")
                )
                  cleared()
              })
            }}
          >
            {session.busy ? "正在核对…" : "核对原许可回答"}
          </Button>
        )
      )}
    </div>
  )
}
