import { useEffect, useRef } from "react"
import { X } from "lucide-react"
import type { DesignAnnotationHistoryEntry } from "./types"

export function DesignAnnotationHistory({
  entries,
  onClose
}: {
  entries: DesignAnnotationHistoryEntry[]
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])
  return (
    <dialog
      ref={dialog}
      aria-label="注释历史"
      onCancel={onClose}
      className="m-auto max-h-[80vh] w-[480px] max-w-[90vw] rounded-xl border border-stone-200 bg-white p-0 text-stone-800 shadow-xl backdrop:bg-black/20"
    >
      <div className="flex items-center justify-between border-b border-stone-200 px-5 py-4">
        <div>
          <h2 className="text-sm font-semibold">注释历史</h2>
          <p className="mt-1 text-xs text-stone-500">更新前的注释与绘制标记，按修改批次保留</p>
        </div>
        <button
          type="button"
          aria-label="关闭注释历史"
          onClick={onClose}
          className="rounded p-1 hover:bg-stone-100"
        >
          <X size={16} />
        </button>
      </div>
      <div className="max-h-[60vh] overflow-y-auto p-5">
        {entries.length === 0 && (
          <p className="py-8 text-center text-sm text-stone-500">
            暂无历史注释，设计更新成功后会自动归档。
          </p>
        )}
        {[...entries].reverse().map((entry) => {
          const points = entry.drawStrokes.flatMap((stroke) => stroke.points)
          const minX = Math.min(...points.map((p) => p.x)) - 12
          const minY = Math.min(...points.map((p) => p.y)) - 12
          const width = Math.max(...points.map((p) => p.x)) - minX + 12
          const height = Math.max(...points.map((p) => p.y)) - minY + 12
          return (
            <article
              key={entry.id}
              className="mb-4 rounded-lg border border-stone-200 p-4 last:mb-0"
            >
              <div className="flex justify-between gap-3 text-xs text-stone-500">
                <time>{new Date(entry.createdAt).toLocaleString("zh-CN", { hour12: false })}</time>
                <span>
                  版本 {entry.revision}
                  {entry.variationId ? ` · 方案 ${entry.variationId.toUpperCase()}` : ""}
                </span>
              </div>
              <p className="my-3 whitespace-pre-wrap break-words text-sm font-medium">
                {entry.instruction}
              </p>
              {entry.comments.map((comment) => (
                <div key={comment.id} className="mb-3 border-l-2 border-amber-300 pl-3 text-sm">
                  <p className="mb-1 text-xs text-stone-500">注释 · {comment.elementDesc}</p>
                  <p className="whitespace-pre-wrap break-words">{comment.text}</p>
                </div>
              ))}
              {!!entry.drawStrokes.length && (
                <details className="mb-3 text-xs text-stone-500">
                  <summary className="cursor-pointer">
                    {entry.drawStrokes.length} 个绘制标记
                  </summary>
                  {!!points.length && (
                    <svg
                      role="img"
                      aria-label="历史绘制标记"
                      viewBox={`${minX} ${minY} ${width} ${height}`}
                      className="mt-2 max-h-40 w-full rounded bg-stone-50"
                    >
                      {entry.drawStrokes.map((stroke) => (
                        <polyline
                          key={stroke.id}
                          points={stroke.points.map((p) => `${p.x},${p.y}`).join(" ")}
                          fill="none"
                          stroke={stroke.color}
                          strokeWidth={stroke.width}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      ))}
                    </svg>
                  )}
                </details>
              )}
              {entry.drawNotes.map((note) => (
                <div key={note.id} className="mb-3 border-l-2 border-rose-300 pl-3 text-sm">
                  <p className="mb-1 text-xs text-stone-500">
                    绘制说明{note.elements.length ? ` · ${note.elements.join("、")}` : ""}
                  </p>
                  <p className="whitespace-pre-wrap break-words">{note.text}</p>
                </div>
              ))}
            </article>
          )
        })}
      </div>
    </dialog>
  )
}
