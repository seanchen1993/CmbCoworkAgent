import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import {
  designDirectEditRuntime,
  type DesignEditorController
} from "@/lib/design-direct-edit-runtime"
import type {
  DesignEditableDocument,
  DesignEditableNode,
  DesignEditCommand
} from "../../../../shared/design-edit"
import type { ElementStyles } from "./types"
import { getDesignSessionClient } from "./session-client"

interface Options {
  id: string | null
  active: boolean
  html: string
  revision: number
  tweakRevision?: number
  variationId: string | null
  iframe: RefObject<HTMLIFrameElement | null>
  onSelect: (value: { edId: string; tagName: string; styles: ElementStyles } | null) => void
  onError: (message: string) => void
}
type EditorWindow = Window & { __designEditor?: DesignEditorController }

export function useDesignDirectEdit(options: Options) {
  const latest = useRef(options)
  latest.current = options
  const descriptor = useRef<DesignEditableDocument | null>(null)
  const selected = useRef<DesignEditableNode | null>(null)
  const controller = useRef<DesignEditorController | null>(null)
  const stylePending = useRef(new Map<string, Record<string, string>>())
  const styleWork = useRef<Promise<void> | null>(null)
  const workingStyle = useRef<{ id: string; values: Record<string, string> } | null>(null)
  const styleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [status, setStatus] = useState("")
  const [load, setLoad] = useState(0)
  const onLoad = useCallback(() => setLoad((n) => n + 1), [])
  const install = useCallback((config: DesignEditableDocument) => {
    const { iframe, active } = latest.current
    const w = iframe.current?.contentWindow as EditorWindow | undefined
    if (
      !w ||
      !active ||
      !w.document.body ||
      w.document.readyState === "loading" ||
      Number(w.document.documentElement.dataset.designArtifactRevision) !== config.revision
    )
      return false
    const script = w.document.createElement("script")
    script.setAttribute("data-design-host-runtime", "editor-installer")
    script.textContent = `(${designDirectEditRuntime.toString()})(${JSON.stringify(config).replace(/</g, "\\u003c")})`
    w.document.documentElement.appendChild(script)
    script.remove()
    controller.current = w.__designEditor ?? null
    return true
  }, [])

  useEffect(() => {
    if (!options.id || !options.active || !options.html) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const id = options.id
    void getDesignSessionClient()
      .inspectEditable(id)
      .then((config) => {
        if (cancelled || latest.current.id !== id) return
        descriptor.current = config
        let tries = 0
        const attempt = () => {
          if (cancelled) return
          if (!install(config) && tries++ < 40) timer = setTimeout(attempt, 50)
        }
        attempt()
      })
      .catch((e) => {
        if (!cancelled) latest.current.onError(`无法开启编辑：${String(e)}`)
      })
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [
    options.id,
    options.active,
    options.html,
    options.revision,
    options.tweakRevision,
    load,
    install
  ])

  useEffect(() => {
    const pendingStyles = stylePending.current
    if (!options.active) {
      ;(
        options.iframe.current?.contentWindow as EditorWindow | undefined
      )?.__designEditor?.cleanup()
      selected.current = null
    }
    return () => {
      const editor = controller.current
      const command = editor?.takeCommand()
      if (command && options.id) {
        // A host mode switch can detach the iframe before its final postMessage is delivered.
        void getDesignSessionClient()
          .edit(options.id, {
            protocol: "design-edit/1",
            variationId: options.variationId,
            ...command
          })
          .catch((error) => latest.current.onError(`离开页面后的编辑保存失败：${String(error)}`))
      }
      if (options.id)
        for (const [nodeId, values] of pendingStyles) {
          if (workingStyle.current?.id === nodeId && workingStyle.current.values === values)
            continue
          void getDesignSessionClient()
            .editStyles(options.id, nodeId, values, options.variationId)
            .catch((error) => latest.current.onError(`离开页面后的样式保存失败：${String(error)}`))
        }
      pendingStyles.clear()
      editor?.cleanup()
      controller.current = null
    }
  }, [options.id, options.active, options.iframe, options.variationId])

  useEffect(() => {
    const handler = async (event: MessageEvent) => {
      const o = latest.current,
        w = o.iframe.current?.contentWindow
      const m = event.data
      if (
        !o.active ||
        !o.id ||
        event.source !== w ||
        !m ||
        m.previewInstanceId !== w?.document.documentElement.dataset.designPreviewInstance
      )
        return
      if (m.type === "__design_editor_select") {
        selected.current = descriptor.current?.nodes.find((n) => n.id === m.nodeId) ?? null
        o.onSelect(m.nodeId ? { edId: m.nodeId, tagName: m.tagName, styles: m.styles } : null)
      } else if (m.type === "__design_editor_error") {
        o.onError(String(m.error))
      } else if (m.type === "__design_editor_history") {
        try {
          await getDesignSessionClient().patchHistory(o.id, m.operation)
        } catch (error) {
          o.onError(String(error))
        }
      } else if (m.type === "__design_editor_command") {
        const id = o.id
        setStatus("正在保存…")
        try {
          const command: DesignEditCommand = {
            protocol: "design-edit/1",
            commandId: m.commandId,
            baseRevision: m.revision,
            baseTweakRevision: m.tweakRevision,
            variationId: o.variationId,
            operations: [m.operation]
          }
          await getDesignSessionClient().edit(id, command)
          w?.postMessage(
            {
              type: "__design_editor_result",
              previewInstanceId: m.previewInstanceId,
              commandId: m.commandId
            },
            "*"
          )
          if (latest.current.id === id) setStatus("已保存")
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error)
          w?.postMessage(
            {
              type: "__design_editor_result",
              previewInstanceId: m.previewInstanceId,
              commandId: m.commandId,
              error: text
            },
            "*"
          )
          if (latest.current.id === id) {
            setStatus("保存失败，可重试")
            o.onError(text)
          }
        }
      }
    }
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [])

  const flushStyles = useCallback((): Promise<void> => {
    clearTimeout(styleTimer.current ?? undefined)
    styleTimer.current = null
    if (styleWork.current) return styleWork.current
    const id = latest.current.id
    const variationId = latest.current.variationId
    if (!stylePending.current.size || !id) return Promise.resolve()
    setStatus("正在保存…")
    const work = (async () => {
      try {
        while (stylePending.current.size && latest.current.id === id) {
          const [nodeId, values] = [...stylePending.current][0]
          workingStyle.current = { id: nodeId, values }
          await getDesignSessionClient().editStyles(id, nodeId, values, variationId)
          if (stylePending.current.get(nodeId) === values) stylePending.current.delete(nodeId)
        }
        if (latest.current.id === id) setStatus("已保存")
      } catch (error) {
        if (latest.current.id === id) setStatus("样式未保存，重新调整后可重试")
        throw error
      } finally {
        styleWork.current = null
        workingStyle.current = null
      }
    })()
    styleWork.current = work
    return work
  }, [])
  const changeStyle = useCallback(
    (property: string, value: unknown) => {
      const node = selected.current
      if (!node) return
      if (!node.canStyle) {
        latest.current.onError(node.reason || "动态组件请通过源码或参数修改样式")
        return
      }
      const px = [
        "fontSize",
        "letterSpacing",
        "width",
        "height",
        "paddingTop",
        "paddingRight",
        "paddingBottom",
        "paddingLeft",
        "marginTop",
        "marginRight",
        "marginBottom",
        "marginLeft",
        "borderWidth",
        "borderRadius"
      ]
      const key = property.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())
      const text = String(value) + (px.includes(property) && typeof value === "number" ? "px" : "")
      stylePending.current.set(node.id, { ...stylePending.current.get(node.id), [key]: text })
      clearTimeout(styleTimer.current ?? undefined)
      styleTimer.current = setTimeout(() => {
        void flushStyles().catch((e) => latest.current.onError(String(e)))
      }, 200)
    },
    [flushStyles]
  )
  const flush = useCallback(async () => {
    await (
      latest.current.iframe.current?.contentWindow as EditorWindow | undefined
    )?.__designEditor?.flush()
    await flushStyles()
    if (latest.current.id) await getDesignSessionClient().flush(latest.current.id)
  }, [flushStyles])
  useEffect(
    () => () => {
      clearTimeout(styleTimer.current ?? undefined)
    },
    []
  )
  return {
    status,
    onLoad,
    flush,
    changeStyle,
    editSelected: () =>
      (
        latest.current.iframe.current?.contentWindow as EditorWindow | undefined
      )?.__designEditor?.editSelected(),
    deleteSelected: () =>
      (
        latest.current.iframe.current?.contentWindow as EditorWindow | undefined
      )?.__designEditor?.deleteSelected()
  }
}
