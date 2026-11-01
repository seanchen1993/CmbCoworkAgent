import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useCallback
} from "react"
import type {
  DeveloperEditorApi,
  DeveloperEditorFrame
} from "../../../shared/mods/v2/developer-editor"
import { CodeViewer } from "../components/tabs/CodeViewer"
import { editorIntentMatches, editorIntentScopeMatches } from "./native-editor-intent-scope"
import { windowPresentation } from "./window-presentation"

/** Source-only overlay: never changes the original file tabs, chat tree or composer draft. */
interface NativeEditorIntentProps {
  threadId: string
  workspace: string
  scopeKey: string
  active: boolean
  api: DeveloperEditorApi
}
function editorNavigationAvailable(value: unknown): value is DeveloperEditorApi {
  if (!value || typeof value !== "object") return false
  return [
    "onEditorNavigation",
    "editorNavigationAccept",
    "editorNavigationAck",
    "editorNavigationClose",
    "editorNavigationLaunchExternal"
  ].every((key) => typeof (value as Record<string, unknown>)[key] === "function")
}
export function NativeEditorIntentHost(props: NativeEditorIntentProps) {
  const available = editorNavigationAvailable(props.api)
  const subscribe = useCallback(
    (changed: () => void) => {
      if (!props.active || !available) return () => {}
      const stop = windowPresentation.subscribe(changed)
      document.addEventListener("visibilitychange", changed)
      return () => {
        stop()
        document.removeEventListener("visibilitychange", changed)
      }
    },
    [props.active, available]
  )
  const presentable = useSyncExternalStore(
    subscribe,
    () =>
      available &&
      props.active &&
      windowPresentation.isPresentable(document.visibilityState === "visible"),
    () => false
  )
  return available && props.active && presentable ? (
    <EditorIntentSurface
      key={JSON.stringify([props.threadId, props.workspace, props.scopeKey])}
      {...props}
    />
  ) : null
}

function EditorIntentSurface(props: NativeEditorIntentProps) {
  const { threadId, workspace, scopeKey, active, api } = props
  const [frame, setFrame] = useState<DeveloperEditorFrame | null>(null)
  const [message, setMessage] = useState("")
  const [loaded, setLoaded] = useState(false)
  const [launched, setLaunched] = useState(false)
  const scope = useRef(props)
  const currentFrame = useRef<DeveloperEditorFrame | null>(null)
  useLayoutEffect(() => {
    scope.current = props
    currentFrame.current = frame
  }, [props, frame])
  useEffect(() => {
    let current = true
    const ids = new Set<string>()
    if (!active) return
    const stop = api.onEditorNavigation((event) => {
      if (event.kind === "retire") {
        ids.delete(event.id)
        setFrame((value) => (value?.id === event.id ? null : value))
        return
      }
      if (!current || !editorIntentMatches(event.intent, scope.current)) return
      ids.add(event.intent.id)
      void api.editorNavigationAccept(event.intent.id).then(
        (value) => {
          if (
            !current ||
            !ids.has(value.id) ||
            !scope.current.active ||
            !editorIntentMatches(value, scope.current)
          ) {
            void api.editorNavigationClose(value.id).catch(() => {})
            return
          }
          if (value.id !== event.intent.id || value.path !== event.intent.path) {
            void api.editorNavigationClose(value.id).catch(() => {})
            return
          }
          setLoaded(false)
          setLaunched(false)
          setMessage("")
          setFrame(value)
        },
        () => {
          if (current) setMessage("文件预览已失效，请重新从当前来源打开。")
        }
      )
    })
    return () => {
      current = false
      stop()
      for (const id of ids) void api.editorNavigationClose(id).catch(() => {})
    }
  }, [threadId, workspace, scopeKey, active, api])

  const visible =
    active &&
    frame &&
    (loaded ? editorIntentScopeMatches(frame, props) : editorIntentMatches(frame, props))
  if (!visible) return null
  const close = () => {
    setFrame(null)
    void api.editorNavigationClose(frame.id).catch(() => {})
  }
  return (
    <section
      role="region"
      aria-label="安全源文件预览"
      className="absolute inset-0 z-40 flex min-h-0 flex-col border bg-background"
      data-native-editor-intent={frame.id}
    >
      <header className="flex shrink-0 items-center gap-3 border-b p-2">
        <span>
          {loaded ? "已加载源文件快照（非实时）" : "源文件预览"} · {frame.source.provider}
        </span>
        <span>
          行 {frame.line}，列 {frame.column}（UTF-16）
        </span>
        {frame.externalAvailable && (
          <button
            disabled={!loaded || launched}
            onClick={() => {
              setLaunched(true)
              void api.editorNavigationLaunchExternal(frame.id).then(
                (result) => {
                  if (currentFrame.current?.id === frame.id)
                    setMessage(
                      result.status === "external-launch-requested"
                        ? "已请求原生 IDE 打开；外部窗口及定位状态未知。"
                        : result.reason === "path-requires-built-in-preview"
                          ? "当前路径仅支持内置预览；原生 IDE 启动请求未发送。"
                          : "尚无可用的原生 IDE 配置。"
                    )
                },
                () => {
                  if (currentFrame.current?.id === frame.id)
                    setMessage("启动结果未知；不会自动重试。请核对原生 IDE。")
                }
              )
            }}
          >
            在已配置的 IDE 打开
          </button>
        )}
        <button onClick={close}>关闭预览</button>
      </header>
      {message && <p role="status">{message}</p>}
      <CodeViewer
        key={frame.id}
        filePath={frame.path}
        content={frame.text}
        target={{ id: frame.id, line: frame.line, column: frame.column }}
        onTargetLocated={(result) => {
          if (
            loaded ||
            currentFrame.current?.id !== frame.id ||
            !editorIntentMatches(frame, scope.current)
          )
            return
          void api
            .editorNavigationAck({
              id: frame.id,
              fingerprint: frame.fingerprint,
              status: result ? "preview-loaded" : "failed",
              ...(result ? { line: frame.line, column: frame.column } : {})
            })
            .then(
              () => {
                if (
                  currentFrame.current?.id === frame.id &&
                  scope.current.active &&
                  editorIntentScopeMatches(frame, scope.current)
                )
                  setLoaded(Boolean(result))
              },
              () => {
                if (currentFrame.current?.id === frame.id) setFrame(null)
              }
            )
        }}
      />
    </section>
  )
}
