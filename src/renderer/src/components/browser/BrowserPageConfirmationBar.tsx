import { useSyncExternalStore } from "react"
import {
  getBrowserPageConfirmation,
  subscribeBrowserPageConfirmation
} from "@/lib/browser-page-confirmation"

/** This bar participates in layout so the native viewport starts below its controls. */
export function BrowserPageConfirmationBar({ loading, url }: { loading: boolean; url: string }) {
  const confirmation = useSyncExternalStore(
    subscribeBrowserPageConfirmation,
    getBrowserPageConfirmation
  )
  if (!confirmation) return null
  const capturing = confirmation.phase === "capturing"
  const disabled = confirmation.phase !== "ready" || loading || !/^https?:\/\//i.test(url)
  return (
    <section
      aria-label={confirmation.confirmLabel || "确认页面并还原"}
      className="shrink-0 border-b border-border bg-background-elevated px-3 py-3 text-xs"
    >
      <p className="font-medium text-foreground">
        {confirmation.title || "确认当前页面后还原设计"}
      </p>
      <p role="status" aria-live="polite" className="mt-1 text-muted-foreground">
        {confirmation.message}
      </p>
      {confirmation.error && (
        <p role="alert" className="mt-2 text-destructive">
          {confirmation.error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={confirmation.onConfirm}
          className="rounded-md bg-foreground px-3 py-2 font-medium text-background disabled:opacity-50"
        >
          {capturing && confirmation.activeAction !== "secondary"
            ? confirmation.busyLabel || "正在还原…"
            : confirmation.confirmLabel || "确认页面并还原"}
        </button>
        {confirmation.secondaryAction && (
          <button
            type="button"
            disabled={disabled}
            onClick={confirmation.secondaryAction.onConfirm}
            className="rounded-md border border-border px-3 py-2 font-medium disabled:opacity-50"
          >
            {capturing && confirmation.activeAction === "secondary"
              ? confirmation.busyLabel
              : confirmation.secondaryAction.label}
          </button>
        )}
        <button
          type="button"
          disabled={confirmation.phase === "opening" || capturing}
          onClick={confirmation.onEditUrl}
          className="rounded-md border border-border px-3 py-2 disabled:opacity-50"
        >
          修改链接
        </button>
        <button
          type="button"
          onClick={confirmation.onCancel}
          className="rounded-md border border-border px-3 py-2"
        >
          {capturing ? confirmation.cancelLabel || "取消还原" : "取消"}
        </button>
        {confirmation.restricted && !capturing && (
          <button
            type="button"
            disabled={disabled}
            onClick={confirmation.onConfirmRestricted}
            className="py-1 text-muted-foreground underline"
          >
            {confirmation.restrictedLabel || "仍然还原当前页面"}
          </button>
        )}
      </div>
    </section>
  )
}
