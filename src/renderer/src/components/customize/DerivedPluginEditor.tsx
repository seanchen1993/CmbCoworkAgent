import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import type {
  PluginDerivationCopy,
  PluginDerivationScope
} from "../../../../shared/plugin-derivation"

export function DerivedPluginEditor({
  scope,
  copy,
  disabled,
  onSaved,
  onDirty
}: {
  scope: PluginDerivationScope
  copy: PluginDerivationCopy
  disabled: boolean
  onSaved(copy: PluginDerivationCopy): void
  onDirty(dirty: boolean): void
}) {
  const [files, setFiles] = useState<string[]>([])
  const [file, setFile] = useState<{ path: string; text: string; digest: string } | null>(null)
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const request = useRef(0)
  const previousCopyDigest = useRef(copy.digest)
  const dirty = !!file && text !== file.text
  function invalidateRead() {
    request.current++
  }
  useEffect(() => {
    onDirty(dirty)
  }, [dirty, onDirty])
  useEffect(() => {
    // A confirmed generated proposal may update the file while this editor is folded.
    // Never offer the previously loaded content as the current version.
    const changed = previousCopyDigest.current !== copy.digest
    previousCopyDigest.current = copy.digest
    if (changed && file && !dirty && file.digest !== copy.digest) {
      setFile(null)
      setText("")
    }
  }, [copy.digest, dirty, file])
  useEffect(() => {
    const sequence = ++request.current
    void window.api.pluginDerivation
      .listEditableFiles({ ...scope, copyId: copy.copyId })
      .then((values) => {
        if (request.current === sequence) setFiles(values)
      })
      .catch((cause) => {
        if (request.current === sequence) setError(String(cause))
      })
    return invalidateRead
    // Scope and source are keyed by the parent; file content is read only after selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [copy.copyId])
  async function read(path: string) {
    if (!path || busy || dirty) return
    const sequence = ++request.current
    setBusy(true)
    setError("")
    try {
      const result = await window.api.pluginDerivation.readFile({
        ...scope,
        copyId: copy.copyId,
        path
      })
      if (request.current === sequence) {
        setFile(result)
        setText(result.text)
      }
    } catch (cause) {
      if (request.current === sequence) setError(String(cause))
    } finally {
      if (request.current === sequence) setBusy(false)
    }
  }
  return (
    <section aria-label="手动编辑插件文件" className="space-y-2 rounded-lg border p-3 text-sm">
      <p className="font-medium">手动编辑插件文件</p>
      <p className="text-xs text-muted-foreground">
        选择文件，修改其中的说明或代码。请保留原有检查规则，保存后重新检查能否安装。
      </p>
      <select
        aria-label="要修改的文件"
        value={file?.path ?? ""}
        disabled={disabled || busy || dirty}
        className="w-full rounded border bg-background p-2"
        onChange={(event) => void read(event.target.value)}
      >
        <option value="">选择要编辑的文件</option>
        {[...files]
          .sort(
            (a, b) =>
              Number(!/SKILL\.md$/i.test(a)) - Number(!/SKILL\.md$/i.test(b)) || a.localeCompare(b)
          )
          .map((path) => (
            <option key={path} value={path}>
              {path}
            </option>
          ))}
      </select>
      {file && (
        <>
          <textarea
            aria-label="副本文件内容"
            className="min-h-64 w-full rounded border bg-background p-2 font-mono text-xs"
            value={text}
            disabled={disabled || busy}
            onChange={(event) => setText(event.target.value)}
          />
          <Button
            disabled={disabled || busy || !dirty}
            onClick={() => {
              const sequence = ++request.current
              setBusy(true)
              setError("")
              void window.api.pluginDerivation
                .saveFile({
                  ...scope,
                  copyId: copy.copyId,
                  path: file.path,
                  text,
                  expectedDigest: file.digest
                })
                .then((value) => {
                  if (request.current !== sequence) return
                  setFile({ ...file, text, digest: value.digest })
                  onDirty(false)
                  onSaved(value)
                })
                .catch((cause) => {
                  if (request.current === sequence) setError(String(cause))
                })
                .finally(() => {
                  if (request.current === sequence) setBusy(false)
                })
            }}
          >
            {busy ? "处理中…" : "保存文件"}
          </Button>
          {dirty && (
            <Button variant="ghost" disabled={busy} onClick={() => setText(file.text)}>
              放弃未保存的修改
            </Button>
          )}
        </>
      )}
      {error && (
        <p role="alert" className="break-words text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
