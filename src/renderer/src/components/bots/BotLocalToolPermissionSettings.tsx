import { useEffect } from "react"
import { Check, LoaderCircle, Monitor, RefreshCw, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { botApi } from "@/lib/bot-api"
import { useBotSettingsSave } from "@/lib/use-bot-settings-save"
import { useBotWorkspaceStore } from "@/lib/bot-workspace-store"
import {
  pendingLocalToolPolicy,
  localToolRecoveryRecord,
  discardRetiredLocalToolRecord,
  type LocalToolPolicySave
} from "@/lib/bot-local-tool-permission-pending"
import type { BotLocalToolPolicy } from "../../../../shared/bot-local-tool-permission"
import { BotDialogContent } from "./BotDialog"
import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"
import { BotLocalToolAnswerRecovery } from "./BotLocalToolAnswerRecovery"

const choices = [
  {
    choice: "ask",
    label: "每次询问",
    detail: "任务读取本机项目或执行命令、修改文件前，先由你确认。"
  },
  {
    choice: "always",
    label: "始终允许",
    detail: "允许本工作区的 Bot 访问这台电脑上的已配置项目，仍需原操作审批。"
  },
  { choice: "never", label: "禁止访问", detail: "阻止新的本机项目操作，并撤销尚未执行的旧许可。" }
] as const
export function BotLocalToolPermissionSettings({
  close,
  supported
}: {
  close(): void
  supported: boolean
}) {
  const session = useBotSettingsSave<LocalToolPolicySave, BotLocalToolPolicy & { botId: null }>({
    botId: null,
    pending: pendingLocalToolPolicy,
    read: async () => ({ ...(await botApi.localToolPermission()), botId: null }),
    change: async ({ botId, ...input }) => {
      void botId
      return { ...(await botApi.changeLocalToolPermission(input)), botId: null }
    },
    verifies: (input, receipt) =>
      receipt.target.id === input.targetId &&
      receipt.dataEpoch === input.dataEpoch &&
      receipt.revision === input.revision + 1 &&
      receipt.choice === input.choice,
    retiredCodes: ["local_computer_changed"]
  })
  const { load } = session
  useEffect(() => {
    if (supported) void load()
  }, [supported, load])
  const value = session.value
  const recoveryRecord = localToolRecoveryRecord(session.record, value?.target.id)
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <BotDialogContent className="flex max-h-[85vh] max-w-xl flex-col" aria-busy={session.busy}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck size={19} />
            本机项目访问
          </DialogTitle>
          <DialogDescription>
            管理 Bot 对用户本机项目的访问，不改变专用浏览器和受管工作目录的权限。
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
          {!supported ? (
            <p role="alert" className="text-sm text-muted-foreground">
              请更新 Bot 后台，以使用本机项目访问设置。
            </p>
          ) : (
            <>
              {value && (
                <div className="flex items-center gap-3 rounded-xl border bg-muted/20 px-4 py-3">
                  <Monitor size={19} className="shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium">{value.target.label}</p>
                    <p className="text-xs text-muted-foreground">当前 Bot 后台所在的电脑</p>
                  </div>
                </div>
              )}
              {!value && !session.error && (
                <p className="py-6 text-center text-sm text-muted-foreground">正在读取本机许可…</p>
              )}
              {session.error && (
                <div role="alert" className="space-y-2 text-sm text-destructive">
                  <p>{session.error}</p>
                  {!session.restored && !session.pending && (
                    <Button size="sm" variant="outline" onClick={() => void session.load()}>
                      <RefreshCw size={13} className="mr-1.5" />
                      重新读取
                    </Button>
                  )}
                </div>
              )}
              {session.restored && (
                <p role="alert" className="text-sm text-destructive">
                  电脑或工作区已变化，请重新打开设置。原请求记录仍保留。
                </p>
              )}
              {recoveryRecord.kind !== "empty" && recoveryRecord.kind !== "valid" && (
                <BotPendingSaveRecovery
                  operationLabel="本机许可"
                  record={recoveryRecord}
                  obsoleteTitle={
                    session.record.kind === "valid" && recoveryRecord.kind === "obsolete"
                      ? "执行电脑已变化，原许可记录仍保留"
                      : undefined
                  }
                  dataEpoch={session.epoch}
                  discard={(raw) =>
                    useBotWorkspaceStore.getState().snapshot?.dataEpoch === session.epoch &&
                    discardRetiredLocalToolRecord(
                      pendingLocalToolPolicy,
                      session.epoch,
                      value?.target.id,
                      raw
                    )
                  }
                  onRepaired={session.refreshRecord}
                />
              )}
              {(session.pending || session.acknowledged) && recoveryRecord.kind === "valid" && (
                <div className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 text-sm">
                  <p>
                    {session.acknowledged
                      ? "修改结果已确认，重试只核对记录并读取当前设置。"
                      : "上次修改结果尚未确认，请先核对原请求。"}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    disabled={session.saveDisabled}
                    onClick={() => void session.save()}
                  >
                    {session.busy && (
                      <LoaderCircle
                        size={13}
                        className="mr-1.5 animate-spin motion-reduce:animate-none"
                      />
                    )}
                    核对上次修改
                  </Button>
                </div>
              )}
              {value && (
                <div role="group" aria-label="本机项目访问策略" className="space-y-2">
                  {choices.map(({ choice, label, detail }) => (
                    <button
                      key={choice}
                      type="button"
                      aria-pressed={value.choice === choice}
                      data-current={value.choice === choice || undefined}
                      disabled={session.fieldsDisabled || value.choice === choice}
                      className="flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-60 data-[current=true]:opacity-100 motion-reduce:transition-none"
                      onClick={() =>
                        void session.save(() => ({
                          botId: null,
                          nonce: crypto.randomUUID(),
                          targetId: value.target.id,
                          dataEpoch: value.dataEpoch,
                          revision: value.revision,
                          choice
                        }))
                      }
                    >
                      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border">
                        {value.choice === choice && <Check size={12} />}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{label}</span>
                        <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                          {detail}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {value && value.effective !== value.choice && (
                <p className="text-xs text-muted-foreground">
                  管理员限制更严格，当前实际策略为“
                  {choices.find((entry) => entry.choice === value.effective)?.label}”。
                </p>
              )}
              <BotLocalToolAnswerRecovery />
              <p className="text-xs leading-5 text-muted-foreground">
                本次允许仅覆盖卡片所列操作，最长 10
                分钟。更改设置会让旧的未执行许可失效；文件边界、命令沙箱、插件授权和原动作审批仍然生效。
              </p>
            </>
          )}
        </div>
        <div className="flex shrink-0 justify-end border-t pt-3">
          <Button variant="outline" size="sm" onClick={close}>
            完成
          </Button>
        </div>
      </BotDialogContent>
    </Dialog>
  )
}
