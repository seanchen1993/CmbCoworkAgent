import { Button } from "@/components/ui/button"

/** The four choices bind to the same exact interaction; only explicit long-term choices persist. */
export function BotApprovalActions({
  busy,
  pluginGrant,
  canRemember,
  canDeny,
  submit
}: {
  busy: boolean
  pluginGrant: boolean
  canRemember: boolean
  canDeny: boolean
  submit(answer: "approve" | "reject", remember?: boolean): void
}) {
  return (
    <>
      <Button size="sm" disabled={busy} onClick={() => submit("approve")}>
        {pluginGrant ? "授权此版本" : "批准本次操作"}
      </Button>
      {canRemember && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => submit("approve", true)}>
          始终允许
        </Button>
      )}
      {canDeny && (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => submit("reject", true)}>
          从不允许
        </Button>
      )}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => submit("reject")}>
        拒绝本次
      </Button>
    </>
  )
}
