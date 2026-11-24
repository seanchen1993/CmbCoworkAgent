import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react"
import {
  designDirectEditRuntime,
  type DesignEditorMode,
  type DesignEditorController
} from "@/lib/design-direct-edit-runtime"
import type {
  DesignEditableDocument,
  DesignEditableNode,
  DesignEditCommand
} from "../../../../shared/design-edit"
import type { ElementStyles } from "./types"
import { getDesignSessionClient } from "./session-client"
import { CanvasEditorFlush } from "./canvas-editor-flush"
import { previewDocuments } from "@/lib/design-frame-dom"
import { splitFrameNodeId } from "../../../../shared/design-captured-frame"

interface Options {
  id: string | null
  active: boolean
  mode: DesignEditorMode
  html: string
  revision: number
  tweakRevision?: number
  variationId: string | null
  iframe: RefObject<HTMLIFrameElement | null>
  crossOriginBridge?: { origin: string; previewInstanceId: string } | null
  onSelect: (value: { edId: string; tagName: string; styles: ElementStyles } | null) => void
  onError: (message: string) => void
}
type EditorWindow = Window & { __designEditor?: DesignEditorController }

export function useDesignDirectEdit(options: Options) {
  const latest = useRef(options)
  latest.current = options
  const descriptor = useRef<DesignEditableDocument | null>(null)
  const selected = useRef<DesignEditableNode | null>(null)
  const controllers = useRef(new Map<Window, DesignEditorController>())
  const selectedWindow = useRef<Window | null>(null)
  const stylePending = useRef(new Map<string, Record<string, string>>())
  const styleWork = useRef<Promise<void> | null>(null)
  const workingStyle = useRef<{ id: string; values: Record<string, string> } | null>(null)
  const styleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bridgeInstance = options.crossOriginBridge?.previewInstanceId
  const bridgeOrigin = options.crossOriginBridge?.origin
  const bridgeFlush = useMemo(
    () => new CanvasEditorFlush(),
    [options.id, options.active, bridgeInstance]
  )
  useLayoutEffect(() => {
    const frame = options.iframe.current?.contentWindow
    return () => {
      bridgeFlush.close()
      if (options.active && frame && bridgeOrigin && bridgeInstance) {
        frame.postMessage({
          type: "__design_editor_action", action: "cleanup", previewInstanceId: bridgeInstance
        }, bridgeOrigin)
      }
    }
  }, [bridgeFlush, bridgeOrigin, bridgeInstance, options.active, options.iframe])
  const [status, setStatus] = useState("")
  const [load, setLoad] = useState(0)
  const onLoad = useCallback(() => setLoad((n) => n + 1), [])
  const postToBridge = useCallback((payload: Record<string, unknown>): boolean => {
    const bridge = latest.current.crossOriginBridge
    const win = latest.current.iframe.current?.contentWindow
    if (!bridge || !win) return false
    win.postMessage({ previewInstanceId: bridge.previewInstanceId, ...payload }, bridge.origin)
    return true
  }, [])
  const install = useCallback((config: DesignEditableDocument) => {
    const { iframe, active, mode, crossOriginBridge } = latest.current
    if (crossOriginBridge) {
      if (!active || !iframe.current?.contentWindow) return false
      iframe.current.contentWindow.postMessage(
        {
          type: "__design_editor_config",
          previewInstanceId: crossOriginBridge.previewInstanceId,
          config,
          mode
        },
        crossOriginBridge.origin
      )
      return true
    }
    const w = iframe.current?.contentWindow as EditorWindow | undefined
    if (
      !w ||
      !active ||
      !w.document.body ||
      w.document.readyState === "loading" ||
      Number(w.document.documentElement.dataset.designArtifactRevision) !== config.revision
    )
      return false
    const next = new Map<Window, DesignEditorController>()
    const instance = w.document.documentElement.dataset.designPreviewInstance
    const nodes = new Map<string | undefined, DesignEditableNode[]>()
    for (const node of config.nodes) {
      const frameId = splitFrameNodeId(node.id)?.frameId
      const group = nodes.get(frameId)
      if (group) group.push(node)
      else nodes.set(frameId, [node])
    }
    for (const { doc, frameId, depth } of previewDocuments(w.document)) {
      const current = doc.defaultView as EditorWindow | null
      if (!current || (frameId && !nodes.has(frameId))) continue
      const local = { ...config, nodes: nodes.get(frameId) ?? [] }
      if (current.__designEditor) current.__designEditor.update(local, mode)
      else {
        const script = doc.createElement("script")
        script.setAttribute("data-design-host-runtime", "editor-installer")
        const args = JSON.stringify([local, mode, frameId, depth, instance]).replace(/</g, "\\u003c")
        script.textContent = `(${designDirectEditRuntime.toString()})(...${args})`
        doc.documentElement.appendChild(script)
        script.remove()
      }
      if (current.__designEditor) next.set(current, current.__designEditor)
    }
    for (const [source, editor] of controllers.current)
      if (!next.has(source)) editor.cleanup()
    if (selectedWindow.current && !next.has(selectedWindow.current)) {
      selectedWindow.current = null
      selected.current = null
    }
    controllers.current = next
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
    options.mode,
    options.html,
    options.revision,
    options.tweakRevision,
    options.crossOriginBridge?.previewInstanceId,
    load,
    install
  ])

  useEffect(() => {
    const pendingStyles = stylePending.current
    if (!options.active) {
      selected.current = null
      selectedWindow.current = null
    }
    return () => {
      const editor = selectedWindow.current && controllers.current.get(selectedWindow.current)
      const command = editor ? editor.takeCommand() : null
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
      for (const current of controllers.current.values()) current.cleanup()
      controllers.current.clear()
      selectedWindow.current = null

    }
  }, [options.id, options.active, options.iframe, options.variationId])

  useLayoutEffect(() => {
    const handler = async (event: MessageEvent) => {
      const o = latest.current
      const bridge = o.crossOriginBridge
      const w = event.source as Window | null
      const m = event.data
      if (!o.active || !o.id || !w || !m) return
      if (bridge) {
        if (
          w !== o.iframe.current?.contentWindow ||
          event.origin !== bridge.origin ||
          m.previewInstanceId !== bridge.previewInstanceId
        ) {
          return
        }
      } else {
        const root = o.iframe.current?.contentDocument
        if (
          !root ||
          !controllers.current.has(w) ||
          !previewDocuments(root).some(({ doc }) => doc.defaultView === w) ||
          m.previewInstanceId !== root.documentElement.dataset.designPreviewInstance
        ) {
          return
        }
      }
      const targetOrigin = bridge ? bridge.origin : "*"

      if (bridge && m.type === "__design_editor_ready") {
        bridgeFlush.ready = true
        return
      }
      if (bridge && m.type === "__design_editor_flush_reply") {
        bridgeFlush.reply(m.requestId, m.error)
        return
      }
      if (m.type === "__design_editor_select") {
        if (!bridge && !m.nodeId && selectedWindow.current && selectedWindow.current !== w) return
        if (!bridge && m.nodeId && selectedWindow.current && selectedWindow.current !== w)
          controllers.current.get(selectedWindow.current)?.clearSelection()
        selected.current = descriptor.current?.nodes.find((n) => n.id === m.nodeId) ?? null
        selectedWindow.current = !bridge && selected.current ? w : null
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
          const save = getDesignSessionClient().edit(id, command)
          if (bridge) bridgeFlush.track(save)
          await save
          w?.postMessage(
            {
              type: "__design_editor_result",
              previewInstanceId: m.previewInstanceId,
              commandId: m.commandId
            },
            targetOrigin
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
            targetOrigin
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
  }, [bridgeFlush])

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
    if (latest.current.crossOriginBridge && latest.current.active) {
      await bridgeFlush.flush((requestId) =>
        postToBridge({ type: "__design_editor_action", action: "flush", requestId })
      )
    } else {
      for (const editor of controllers.current.values()) await editor.flush()
    }
    await flushStyles()
    if (latest.current.id) await getDesignSessionClient().flush(latest.current.id)
  }, [bridgeFlush, flushStyles, postToBridge])
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
    editSelected: () => {
      if (postToBridge({ type: "__design_editor_action", action: "editSelected" })) return
      if (selectedWindow.current) controllers.current.get(selectedWindow.current)?.editSelected()
    },
    deleteSelected: () => {
      if (postToBridge({ type: "__design_editor_action", action: "deleteSelected" })) return
      if (selectedWindow.current) controllers.current.get(selectedWindow.current)?.deleteSelected()
    }
  }
}
