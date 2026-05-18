import { AutoCommitControl } from "@/components/chat/AutoCommitControl"

export function CommitPolicyPanel(): React.JSX.Element {
  return (
    <div className="flex flex-1 overflow-auto">
      <div className="w-full max-w-3xl space-y-5 p-6">
        <div>
          <h2 className="text-lg font-semibold">提交策略</h2>
          <p className="mt-1 text-sm text-muted-foreground">管理任务结束后的提交行为。</p>
        </div>
        <AutoCommitControl variant="panel" />
      </div>
    </div>
  )
}
