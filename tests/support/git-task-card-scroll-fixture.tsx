import { useState } from "react"
import { createRoot } from "react-dom/client"
import { AgentGitCommitDialog } from "../../src/renderer/src/components/chat/AgentGitCommitDialog"
import { GitCommitDialog } from "../../src/renderer/src/components/panels/GitCommitDialog"

const cards = Array.from({ length: 40 }, (_, index) => ({
  taskKey: `TASK-${String(index + 1).padStart(2, "0")}`,
  taskName: `Task card ${index + 1}`,
  updatedTime: new Date(Date.UTC(2026, 5, 4, 0, 0, index)).toISOString()
}))

Object.assign(window, {
  api: {
    taskCards: { list: async () => ({ success: true, cards }) },
    workspace: {
      getGitPanelDiffs: async () => ({
        success: true,
        files: [{ path: "example.ts", additions: 1, deletions: 0, diff: "", diffLoaded: true }],
        changedFiles: ["example.ts"],
        totals: { fileCount: 1, additions: 1, deletions: 0 }
      })
    }
  }
})

const ignoreChange = (): void => undefined

export function ManualCommitFixture(): React.JSX.Element {
  const [cardNumber, setCardNumber] = useState("")
  return (
    <GitCommitDialog
      open
      running={false}
      branch="uat-without-mods"
      fileCount={1}
      additions={1}
      deletions={0}
      cardNumber={cardNumber}
      commitType="fix"
      commitMessage="Check the card list"
      commitHistory={[]}
      onOpenChange={ignoreChange}
      onCardNumberChange={setCardNumber}
      onCommitTypeChange={ignoreChange}
      onCommitMessageChange={ignoreChange}
      onHistorySelect={ignoreChange}
      onSubmit={ignoreChange}
    />
  )
}

const container = document.getElementById("root")!
createRoot(container).render(
  container.dataset.commitMode === "agent" ? (
    <AgentGitCommitDialog
      open
      threadId="task-card-scroll"
      suggestedMessage="Check the card list"
      onCommitted={ignoreChange}
      onCancel={ignoreChange}
    />
  ) : (
    <ManualCommitFixture />
  )
)
