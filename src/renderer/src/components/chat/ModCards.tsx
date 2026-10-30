import { useCallback, useState, useSyncExternalStore } from "react"
import type { ModUiNode } from "../../../../shared/mods/types"
import { Button } from "@/components/ui/button"
import { getModCards, subscribeModCards } from "@/lib/mod-cards-store"

export function ModCards({
  threadId,
  callId,
  slot
}: {
  threadId: string
  callId?: string
  slot?: "turn.summary"
}): React.JSX.Element | null {
  const subscribe = useCallback(
    (listener: () => void) => subscribeModCards(threadId, listener),
    [threadId]
  )
  const snapshot = useCallback(() => getModCards(threadId), [threadId])
  const all = useSyncExternalStore(subscribe, snapshot)
  const summaryCallId = slot ? all.filter((card) => card.slot === slot).at(-1)?.callId : undefined
  const cards = all.filter((card) =>
    slot ? card.slot === slot && card.callId === summaryCallId : card.callId === callId
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [used, setUsed] = useState<Set<string>>(new Set())
  const [result, setResult] = useState("")

  async function act(actionId: string): Promise<void> {
    setBusy(actionId)
    setUsed((previous) => new Set(previous).add(actionId))
    try {
      setResult((await window.api.mods.act(threadId, actionId)).text)
    } catch (error) {
      setResult(error instanceof Error ? error.message : "插件操作未完成")
    } finally {
      setBusy(null)
    }
  }
  function render(node: ModUiNode, key: string): React.ReactNode {
    switch (node.type) {
      case "artifact-link":
        return (
          <span key={key} className="inline-flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void window.api.mods.artifact(threadId, node.artifactId).then(
                  (artifact) => setResult(`${artifact.label}\n${artifact.text}`),
                  (error) => setResult(String(error))
                )
              }
            >
              {node.label}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void window.api.mods
                  .saveArtifact(threadId, node.artifactId)
                  .catch((error) => setResult(String(error)))
              }
            >
              导出文本
            </Button>
          </span>
        )
      case "text":
        return (
          <p key={key} className="whitespace-pre-wrap break-words">
            {node.text}
          </p>
        )
      case "code":
        return (
          <pre key={key} className="max-h-60 overflow-auto whitespace-pre-wrap">
            {node.text}
          </pre>
        )
      case "badge":
        return (
          <span key={key} className="rounded border px-1.5 py-0.5">
            {node.text}
          </span>
        )
      case "card":
        return (
          <div key={key} className="rounded border p-2 space-y-2">
            <strong>{node.title}</strong>
            {node.children.map((child, i) => render(child, `${key}.${i}`))}
          </div>
        )
      case "table":
        return (
          <div key={key} className="overflow-auto">
            <table>
              <thead>
                <tr>
                  {node.columns.map((name, i) => (
                    <th key={i}>{name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {node.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td className="p-1" key={j}>
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      case "button":
        return (
          <Button
            key={key}
            size="sm"
            variant="outline"
            disabled={!node.actionId || busy !== null || used.has(node.actionId)}
            onClick={() => node.actionId && void act(node.actionId)}
          >
            {busy === node.actionId ? "执行中…" : node.label}
          </Button>
        )
    }
  }
  if (cards.length === 0) return null
  return (
    <div
      className={`${slot ? "rounded-lg border bg-background/95 max-h-64 overflow-auto" : "border-t"} p-3 space-y-3 text-xs`}
      data-mod-cards
    >
      {slot && <p className="font-medium">最近一次扩展总结</p>}
      {cards.map((card) => (
        <section key={card.id} data-mod-card={card.modId} className="space-y-2">
          <p className="text-muted-foreground">由 {card.name} 提供</p>
          {card.nodes.map((node, i) => render(node, `${card.id}.${i}`))}
        </section>
      ))}
      {result && (
        <pre aria-live="polite" className="max-h-64 overflow-auto whitespace-pre-wrap">
          {result}
        </pre>
      )}
    </div>
  )
}
