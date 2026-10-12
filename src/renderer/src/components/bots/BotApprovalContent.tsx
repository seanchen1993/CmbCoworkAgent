import { readBotBrowserUploadCard } from "../../../../shared/bot-browser-upload"
import { botPeerApprovalDispatch } from "../../../../shared/bot-peer-dispatch"
import { BotPeerImages } from "./BotPeerImages"
import { botPeerImageSources } from "../../../../shared/bot-peer-images"
import { botPeerFileSources, type BotPeerFileSource } from "../../../../shared/bot-peer-files"
import { botGroupPostAction } from "../../../../shared/bot-group-post"
import { FileText } from "lucide-react"
import { formatAttachmentBytes } from "./upstream/grok-composer-draft"
import { readBotSecretUseCard } from "../../../../shared/bot-secrets"
import { botSkillReference } from "../../../../shared/bot-skill-references"

const browserActions: Record<string, string> = {
  navigate: "打开网页",
  resize: "调整页面尺寸",
  click: "点击页面元素",
  fill: "填写表单",
  type: "输入文本",
  press_key: "发送按键",
  scroll: "滚动页面",
  tabs: "操作浏览器标签页"
}

type BrowserReview = { targetPageUrl?: unknown; elements?: unknown }

function ApprovalFiles({ files }: { files: BotPeerFileSource[] }) {
  return (
    <ul className="space-y-2" aria-label="将交接的文件">
      {files.map((file) => (
        <li
          key={file.sourceId}
          className="flex min-w-0 items-center gap-3 rounded-xl border border-border/65 bg-background px-3 py-2.5"
        >
          <FileText
            size={18}
            strokeWidth={1.6}
            className="shrink-0 text-muted-foreground"
            aria-hidden
          />
          <span className="min-w-0">
            <span className="block break-words text-sm font-medium">{file.name}</span>
            <span className="block text-xs text-muted-foreground">
              {formatAttachmentBytes(file.size)} · 原文件
            </span>
          </span>
        </li>
      ))}
    </ul>
  )
}

function BrowserReviewTargets({
  review,
  showPage = false
}: {
  review?: BrowserReview
  showPage?: boolean
}) {
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      {showPage && typeof review?.targetPageUrl === "string" && (
        <p className="break-words">当前页面：{review.targetPageUrl}</p>
      )}
      {Array.isArray(review?.elements) &&
        review.elements.map((element, index) => (
          <div key={index} className="space-y-1 break-words">
            <p>
              实际目标：
              {typeof element?.label === "string" && element.label
                ? element.label
                : typeof element?.tag === "string"
                  ? element.tag
                  : "页面元素"}
            </p>
            {typeof element?.formAction === "string" && (
              <p>
                表单提交到 {element.formAction}
                {typeof element?.formMethod === "string" && (
                  <> · {element.formMethod.toUpperCase()}</>
                )}
              </p>
            )}
          </div>
        ))}
    </div>
  )
}

/** Older stored approvals remain readable; presentation never changes their bound action. */
export function BotApprovalContent({ prompt }: { prompt: string }) {
  const upload = readBotBrowserUploadCard(prompt)
  if (upload)
    return (
      <div className="space-y-3 text-sm">
        <p className="font-medium">向网站上传文件</p>
        <p className="text-xs text-muted-foreground">{upload.purpose}</p>
        <dl className="space-y-2 rounded-lg border bg-background/60 p-3 text-xs">
          <div>
            <dt className="text-muted-foreground">目标网站</dt>
            <dd className="mt-1 break-all font-medium">{upload.destination.origin}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">页面 / 文件输入框</dt>
            <dd className="mt-1 break-words">
              {upload.destination.title || "无标题页面"} · {upload.destination.field}
            </dd>
            <dd className="mt-1 break-all text-muted-foreground">{upload.destination.url}</dd>
          </div>
          {upload.destination.formAction && (
            <div>
              <dt className="text-muted-foreground">表单目标</dt>
              <dd className="mt-1 break-all">{upload.destination.formAction}</dd>
            </div>
          )}
        </dl>
        <ul className="space-y-2">
          {upload.files.map((file) => (
            <li key={file.id} className="rounded-lg border p-3 text-xs">
              <p className="break-words font-medium">{file.name}</p>
              <p className="mt-1 text-muted-foreground">
                {file.size.toLocaleString()} 字节 · {file.mime}
              </p>
              <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">
                SHA-256 {file.sha256}
              </p>
            </li>
          ))}
        </ul>
        <p className="text-xs leading-relaxed text-muted-foreground">
          选择文件即可触发网站传输，无需再点击提交。此批准仅针对以上原件和页面；页面、输入框或控制权变化后需重新确认。
        </p>
      </div>
    )
  const secret = readBotSecretUseCard(prompt)
  if (secret)
    return (
      <div className="space-y-3 text-sm">
        <p>
          使用已保存凭据 <strong>{secret.credential.name}</strong>
        </p>
        <dl className="space-y-2 rounded-lg border bg-background/60 p-3 text-xs">
          <div>
            <dt className="text-muted-foreground">目标网站</dt>
            <dd className="mt-1 break-all font-medium">{secret.destination.origin}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">页面 / 输入框</dt>
            <dd className="mt-1 break-all">
              {secret.destination.path} · {secret.destination.field}
            </dd>
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">
          仅填入该密码框，不提交表单。凭据替换、删除或页面变化后，需要重新申请。
        </p>
      </div>
    )
  let action: Record<string, unknown> | null = null
  let browserReview: BrowserReview | undefined
  try {
    const value = JSON.parse(prompt)
    const command = value?.pluginCommand
    if (
      command &&
      typeof command.name === "string" &&
      typeof command.arguments === "string" &&
      typeof command.plugin === "string"
    )
      return (
        <div className="space-y-3 text-sm">
          <p className="font-medium">运行插件命令 · {command.name}</p>
          <p className="text-xs text-muted-foreground">
            {command.plugin.replace(/^function:/, "")}
          </p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-background/60 p-3 text-xs">
            {command.arguments || "无参数"}
          </pre>
          <p className="text-xs text-muted-foreground">
            {command.immediate
              ? "此命令仅可调用只读能力。"
              : "命令中的文件修改和外部系统操作仍需单独确认。"}
          </p>
        </div>
      )
    const hook = value?.hook
    if (
      hook &&
      typeof hook.name === "string" &&
      typeof hook.event === "string" &&
      typeof hook.inputPreview === "string"
    ) {
      const eventNames: Record<string, string> = {
        PreToolUse: "工具执行前",
        PostToolUse: "工具执行后",
        UserPromptSubmit: "提交任务时",
        Notification: "等待操作审批时",
        Setup: "项目初始化时",
        PreSkillUse: "启用技能前",
        PostSkillUse: "技能完成后",
        Stop: "任务交付前",
        SessionStart: "开始任务时",
        SessionEnd: "结束任务时",
        SubagentStart: "子任务开始时",
        SubagentStop: "子任务结束时",
        StopFailure: "任务失败后",
        PostToolUseFailure: "工具失败后"
      }
      return (
        <div className="space-y-3 text-sm">
          <div>
            <p className="font-medium">
              {hook.event === "Notification"
                ? "发送审批通知"
                : typeof hook.version === "number"
                  ? "运行技能检查"
                  : "运行检查"}{" "}
              · {hook.name}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {eventNames[hook.event] ?? hook.event}
              {typeof hook.version === "number"
                ? ` · 第 ${hook.version} 版`
                : typeof hook.version === "string" && /^[a-f0-9]{64}$/.test(hook.version)
                  ? ` · 配置 ${hook.version.slice(0, 12)}`
                  : ""}
            </p>
          </div>
          {hook.event === "Notification" && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              此授权仅用于通知脚本，原操作需单独确认。
            </p>
          )}
          <div className="space-y-3 rounded-lg border bg-background/60 p-3">
            {hook.type === "command" && (
              <>
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-xs">
                  {hook.command}
                </pre>
                <p className="break-all text-xs text-muted-foreground">执行目录：{hook.cwd}</p>
                <p className="text-xs text-muted-foreground">
                  执行环境：
                  {hook.sandbox === "macos-seatbelt"
                    ? "macOS 项目沙箱"
                    : hook.sandbox === "none"
                      ? "本机原生进程"
                      : hook.sandbox === "pending-verification"
                        ? "原生隔离（运行前核验）"
                        : hook.sandbox}
                </p>
              </>
            )}
            {hook.type === "http" && (
              <>
                <p className="text-xs text-muted-foreground">将事件数据发送至</p>
                <p className="break-all text-xs">{hook.url}</p>
              </>
            )}
            {hook.type === "prompt" && (
              <>
                <p className="text-xs text-muted-foreground">模型：{hook.model}</p>
                <p className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-xs">
                  {hook.policy}
                </p>
              </>
            )}
          </div>
          <details className="rounded-lg border p-3 text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              查看事件输入
              {hook.inputCharacters > hook.inputPreview.length
                ? `（预览，完整输入 ${hook.inputCharacters} 字符）`
                : ""}
            </summary>
            <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words">
              {hook.inputPreview}
            </pre>
          </details>
          {hook.event !== "Notification" && (
            <p className="text-xs text-muted-foreground">
              仅授权此次检查；后续文件、命令和外部系统操作仍需各自的授权。
            </p>
          )}
        </div>
      )
    }
    const groupPost = botGroupPostAction.safeParse(value?.groupPost)
    if (groupPost.success) {
      const { destination, message, files } = groupPost.data
      return (
        <div className="space-y-3 text-sm">
          <p className="break-words">
            发送到群聊 <strong>{destination.name}</strong>
          </p>
          <p className="break-words text-xs leading-relaxed text-muted-foreground">
            群内 Bot：{destination.members.map((member) => member.name).join("、")}
          </p>
          <p className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-background/60 p-3">
            {message}
          </p>
          {files.length > 0 && <ApprovalFiles files={files} />}
          <p className="text-xs leading-relaxed text-muted-foreground">
            这条消息{files.length > 0 ? `和 ${files.length} 个原文件` : ""}将在群内公开。
            {destination.threadRootId ? "发送到原任务的分支讨论。" : ""}
          </p>
        </div>
      )
    }
    const profile = value?.botProfile
    const peer = value?.peer
    if (typeof peer?.recipient?.name === "string" && typeof peer.message === "string") {
      const parsedImages = botPeerImageSources.safeParse(peer.images ?? [])
      const images = parsedImages.success ? parsedImages.data : []
      const parsedFiles = botPeerFileSources.safeParse(peer.files ?? [])
      const files = parsedFiles.success ? parsedFiles.data : []
      const sourceConversationId = images[0]?.sourceConversationId
      const parsedDispatch = botPeerApprovalDispatch.safeParse(peer.dispatch)
      const dispatch = parsedDispatch.success ? parsedDispatch.data : null
      const intentLabel = dispatch
        ? {
            request: "发送协作请求",
            reply: "回复原请求",
            question: "请求补充信息",
            status: "发送进展",
            result: "发送结果",
            fyi: "发送参考信息"
          }[dispatch.intent]
        : "派发协作任务"
      return (
        <div className="space-y-3 text-sm">
          <p>
            向 <strong>{peer.recipient.name}</strong> {intentLabel}
          </p>
          {files.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                同时发送 {files.length} 个原文件；接收方可读取这些附件。
              </p>
              <ApprovalFiles files={files} />
            </div>
          )}
          {dispatch?.priority && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              优先处理；仅可请求停止对方的非用户任务。待原操作和资源完成核验后才能执行，用户任务不受影响。
            </p>
          )}
          {dispatch &&
            ["reply", "result"].includes(dispatch.intent) &&
            dispatch.originalRequestId && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                若这是给直接原请求者的回复，它将作为本次响应；任务结束时不会重复发送最终结果。
              </p>
            )}
          <p className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-background/60 p-3">
            {peer.message}
          </p>
          {images.length > 0 &&
            sourceConversationId &&
            images.every((image) => image.sourceConversationId === sourceConversationId) && (
              <>
                <p className="text-xs text-muted-foreground">
                  同时发送 {images.length} 张图片；接收方可查看这些附件。
                </p>
                <BotPeerImages
                  images={images.map((image) => ({ ...image, id: image.sourceId }))}
                  conversationId={sourceConversationId}
                />
              </>
            )}
          <details className="rounded-lg border p-3 text-xs">
            <summary className="cursor-pointer text-muted-foreground">接收方职责与工作范围</summary>
            <p className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words">
              {typeof peer.recipient.instructions === "string"
                ? peer.recipient.instructions
                : "未指定职责"}
            </p>
            <p className="mt-2 break-all text-muted-foreground">
              工作目录：
              {typeof peer.recipient.workspacePath === "string"
                ? peer.recipient.workspacePath
                : "未指定"}
            </p>
            <p className="mt-1 break-all text-muted-foreground">
              连接器：
              {Array.isArray(peer.recipient.connectorIds)
                ? peer.recipient.connectorIds
                    .filter((id: unknown) => typeof id === "string")
                    .join("、") || "未授权"
                : "未授权"}
            </p>
          </details>
          <p className="text-xs text-muted-foreground">
            对方将按自己的职责和权限处理，实际操作仍受审核约束。派发成功不代表任务已经完成。
          </p>
        </div>
      )
    }
    const routine = value?.routine
    if (
      ["create", "update"].includes(routine?.operation) &&
      typeof routine?.after?.name === "string" &&
      typeof routine.after.prompt === "string"
    ) {
      const after = routine.after,
        schedule = after.schedule
      // This belongs to the frozen approval action, never the current catalog.
      const selection = botSkillReference.array().max(6).safeParse(routine.skillReferences)
      const skillReferences = selection.success ? selection.data : []
      const trigger =
        schedule?.kind === "cron"
          ? `日历计划：${schedule.expression}`
          : schedule?.kind === "interval"
            ? `每 ${Number(schedule.everyMs) / 60000} 分钟`
            : schedule?.kind === "event"
              ? `事件：${schedule.topic}`
              : schedule?.kind === "once"
                ? `指定时间：${new Date(schedule.at).toLocaleString()}`
                : "未指定"
      return (
        <div className="space-y-3 text-sm">
          <p>
            {routine.operation === "create" ? "创建例程" : "修改例程"} <strong>{after.name}</strong>
          </p>
          <p className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-background/60 p-3">
            {after.prompt}
          </p>
          <dl className="space-y-2 rounded-lg border p-3 text-xs">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">运行状态</dt>
              <dd>{after.enabled ? "启用" : "暂停"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">触发方式</dt>
              <dd className="break-all text-right">{trigger}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">时区</dt>
              <dd>{typeof after.timezone === "string" ? after.timezone : "未指定"}</dd>
            </div>
            {skillReferences.length > 0 && (
              <div className="flex justify-between gap-3">
                <dt className="shrink-0 text-muted-foreground">绑定技能</dt>
                <dd className="min-w-0 space-y-1 text-right">
                  {skillReferences.map((skill) => (
                    <p key={`${skill.botId}:${skill.id}`} className="break-words">
                      {skill.name} · v{skill.version}
                    </p>
                  ))}
                </dd>
              </div>
            )}
          </dl>
          <p className="text-xs text-muted-foreground">
            保存后按此计划接收工作；实际操作继续受审核约束。确认期间例程若已被修改，本次变更不会覆盖它。
          </p>
        </div>
      )
    }
    if (
      profile &&
      ["create", "update"].includes(profile.operation) &&
      (typeof profile.name === "string" || typeof profile.agent_id === "string")
    ) {
      const creating = profile.operation === "create"
      const nameOnly =
        !creating &&
        typeof profile.name === "string" &&
        Object.keys(profile).every((key) =>
          ["operation", "agent_id", "revision", "name"].includes(key)
        )
      return (
        <div className="space-y-3 text-sm">
          <p>
            {creating ? "创建新的协作 Bot" : nameOnly ? "修改 Bot 名称" : "修改 Bot 名称与职责"}
          </p>
          <dl className="space-y-3 rounded-lg border bg-background/60 p-3">
            {typeof profile.name === "string" && (
              <div>
                <dt className="text-xs text-muted-foreground">名称</dt>
                <dd className="mt-1 font-medium break-words">{profile.name}</dd>
              </div>
            )}
            {typeof profile.agent_id === "string" && (
              <div>
                <dt className="text-xs text-muted-foreground">
                  Bot ID · 当前版本 {profile.revision}
                </dt>
                <dd className="mt-1 break-all text-xs">{profile.agent_id}</dd>
              </div>
            )}
            {typeof profile.description === "string" && (
              <div>
                <dt className="text-xs text-muted-foreground">职责与工作要求</dt>
                <dd className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words">
                  {profile.description || "未指定"}
                </dd>
              </div>
            )}
            {creating && (
              <div className="space-y-1 break-all text-xs text-muted-foreground">
                <p>
                  模型：
                  {typeof profile.modelRef === "string" ? profile.modelRef : "CMBDevClaw 默认模型"}
                </p>
                <p>
                  工作目录：
                  {typeof profile.workspacePath === "string" ? profile.workspacePath : "未指定"}
                </p>
                <p>
                  连接器：
                  {Array.isArray(profile.connectorIds) && profile.connectorIds.length
                    ? profile.connectorIds
                        .filter((id: unknown) => typeof id === "string")
                        .join("、")
                    : "未授权"}
                </p>
              </div>
            )}
          </dl>
          <p className="text-xs text-muted-foreground">
            {creating
              ? "沿用上述模型与工作范围，创建后可单独交办任务。不会复制历史对话、记忆、凭据或插件授权。"
              : nameOnly
                ? "仅修改名称。确认期间配置若有变化，本次修改不会执行。"
                : "仅修改列出的字段，新职责从后续任务生效。确认期间配置若有变化，本次修改不会执行。"}
          </p>
        </div>
      )
    }
    if (
      typeof value?.routineDelete?.name === "string" &&
      typeof value.routineDelete.prompt === "string"
    ) {
      return (
        <div className="space-y-3 text-sm">
          <p>
            删除例程 <strong>{value.routineDelete.name}</strong>
          </p>
          <p className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border bg-background/60 p-3 text-xs">
            {value.routineDelete.prompt}
          </p>
          <p className="text-xs text-muted-foreground">
            取消后续触发和尚未开始的任务；已经运行的任务与历史结果保留。例程若在确认期间发生变化，本次删除不会执行。
          </p>
        </div>
      )
    }
    if (
      typeof value?.pluginGrant?.name === "string" &&
      typeof value.pluginGrant.digest === "string"
    ) {
      return (
        <div className="space-y-3 text-sm">
          <p>
            允许此 Bot 使用插件 <strong>{value.pluginGrant.name}</strong>
          </p>
          <p className="break-all text-xs text-muted-foreground">
            项目：{String(value.pluginGrant.workspace)}
          </p>
          <p className="text-xs text-muted-foreground">
            此版本可读取项目与任务上下文、提供工具并调用已配置的模型。后续任务沿用本次授权；文件修改、命令和连接器操作仍需单独审批。
          </p>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">本次授权的代码版本</summary>
            <p className="mt-2 break-all font-mono">{value.pluginGrant.digest}</p>
          </details>
        </div>
      )
    }
    if (
      typeof value?.download?.url === "string" ||
      typeof value?.download?.ref === "string" ||
      typeof value?.publish?.path === "string"
    ) {
      const download =
        typeof value.download?.url === "string" || typeof value.download?.ref === "string"
      const file = download ? value.download : value.publish
      return (
        <div className="space-y-3 text-sm">
          <p>{download ? "下载文件到当前对话" : "交付项目文件"}</p>
          <div className="space-y-2 rounded-lg border border-border/60 bg-background/60 p-3">
            {typeof file.name === "string" && <p className="break-all font-medium">{file.name}</p>}
            <p className="max-h-32 overflow-auto break-all text-xs text-muted-foreground">
              {download ? (file.url ?? "点击当前页面的导出按钮") : file.path}
            </p>
            {download && typeof file.element === "string" && (
              <p className="break-words text-xs text-muted-foreground">操作用途：{file.element}</p>
            )}
            {download && <BrowserReviewTargets review={value.browserReview} showPage />}
            {!download && typeof file.size === "number" && (
              <p className="text-xs text-muted-foreground">
                {(file.size / 1024).toFixed(1)} KB · 保存到此对话的文件列表
              </p>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {download
              ? "使用 Bot 浏览器的登录状态下载，单个文件最大 25 MiB。"
              : "按当前文件版本交付；审批期间文件若有变化，将停止交付。"}
          </p>
        </div>
      )
    }
    if (typeof value?.shell?.command === "string" && typeof value.shell.cwd === "string") {
      return (
        <div className="space-y-3 text-sm">
          <p>执行项目命令</p>
          <p className="break-all text-xs text-muted-foreground">{value.shell.cwd}</p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border/60 bg-background/60 p-3 font-mono text-xs">
            {value.shell.command}
          </pre>
          {value.shell.definition && typeof value.shell.definition.path === "string" && (
            <div className="space-y-1.5 text-xs text-muted-foreground">
              <p className="break-all">
                {value.shell.definition.kind === "unavailable"
                  ? "未能核对脚本定义，本次需要人工确认"
                  : "已核对脚本定义"}{" "}
                · {value.shell.definition.path}
              </p>
              {typeof value.shell.definition.definition === "string" && (
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/40 p-2 font-mono">
                  {value.shell.definition.definition}
                </pre>
              )}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {value.shell.keepAlive === true
              ? "持续服务：回复结束后继续运行，可在后台任务中停止；服务与后续项目修改并行。"
              : value.shell.background === true
                ? "后台运行，Bot 可继续其他工作。"
                : ""}
            最长运行 {value.shell.timeoutSeconds} 秒。
            {value.shell.sandbox === "none"
              ? "当前未启用系统沙箱，命令使用本机用户权限。"
              : `沙箱：${({ unelevated: "普通权限", readonly: "只读权限", elevated: "提升权限", "macos-seatbelt": "macOS 项目沙箱", "pending-verification": "原生隔离（运行前核验）" } as Record<string, string>)[value.shell.sandbox] ?? value.shell.sandbox}。`}
          </p>
        </div>
      )
    }
    if (
      value?.connector &&
      typeof value.connector.provider === "string" &&
      typeof value.connector.tool === "string"
    ) {
      return (
        <div className="space-y-3 text-sm">
          <p>使用 {value.connector.provider}</p>
          <p className="break-all font-mono text-xs">{value.connector.tool}</p>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border/60 bg-background/60 p-3 text-xs">
            {JSON.stringify(value.connector.arguments, null, 2)}
          </pre>
        </div>
      )
    }
    if (
      typeof value?.skillImport?.destination === "string" &&
      typeof value.skillImport.sha256 === "string" &&
      typeof value.skillImport.size === "number"
    ) {
      const item = value.skillImport
      return (
        <div className="space-y-3 text-sm">
          <p>复制技能模板到项目</p>
          <dl className="space-y-2 rounded-lg border bg-background/60 p-3 text-xs">
            <div>
              <dt className="text-muted-foreground">来源</dt>
              <dd className="mt-1 break-all">
                {String(item.name)} · {String(item.path)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">新文件</dt>
              <dd className="mt-1 break-all font-mono">{item.destination}</dd>
              <dd className="mt-1 break-all text-muted-foreground">{String(item.root)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">大小</dt>
              <dd className="mt-1">{item.size.toLocaleString()} 字节</dd>
            </div>
          </dl>
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">文件校验值</summary>
            <p className="mt-2 break-all font-mono">{item.sha256}</p>
          </details>
          <p className="text-xs text-muted-foreground">
            原样复制，不运行文件。目标已存在或技能源文件变化时，本次复制停止。
          </p>
        </div>
      )
    }
    if (
      value?.project &&
      typeof value.project.path === "string" &&
      typeof value.project.diff === "string"
    ) {
      return (
        <div className="space-y-3 text-sm">
          <p>{value.project.beforeHash === null ? "创建项目文件" : "修改项目文件"}</p>
          <p className="break-all font-mono text-xs">{value.project.path}</p>
          <p className="break-all text-xs text-muted-foreground">{value.project.root}</p>
          <pre className="max-h-80 overflow-auto rounded-lg border border-border/60 bg-background/60 p-3 text-xs">
            {value.project.diff}
          </pre>
          {value.project.diffTruncated && (
            <p className="text-xs text-muted-foreground">
              变更较长，此处显示前半部分；拒绝后可要求拆分修改。
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            同意后保存修改前的文件和差异。若文件已有新改动，本次修改将停止。
          </p>
        </div>
      )
    }
    if (value?.browser && typeof value.browser === "object" && !Array.isArray(value.browser)) {
      action = value.browser
      browserReview = value.browserReview
    }
  } catch {
    /* Questions and previously stored plain-text approvals use their original text. */
  }
  if (!action) return <p className="whitespace-pre-wrap break-words text-sm">{prompt}</p>
  const description = browserActions[String(action.op)] ?? "执行浏览器操作"
  const fields = [
    ["当前页面", browserReview?.targetPageUrl],
    [
      "页面尺寸",
      action.op === "resize" &&
      Number.isSafeInteger(action.width) &&
      Number.isSafeInteger(action.height)
        ? `${action.width} × ${action.height} CSS 像素`
        : undefined
    ],
    ["网址", action.url],
    ["页面元素", action.ref],
    ["操作用途", action.element],
    ["填写内容", action.value ?? action.text],
    ["按键", action.key],
    ["标签页操作", action.action]
  ].filter((entry): entry is [string, string] => typeof entry[1] === "string")
  return (
    <div className="space-y-3 text-sm">
      <p>{description}</p>
      <BrowserReviewTargets review={browserReview} />
      {fields.length > 0 && (
        <dl className="space-y-2 rounded-lg border border-border/60 bg-background/60 p-3">
          {fields.map(([label, value]) => (
            <div key={label} className="grid grid-cols-[5em_1fr] gap-3">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="max-h-32 overflow-auto whitespace-pre-wrap break-words text-xs">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">查看完整操作参数</summary>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all">{prompt}</pre>
      </details>
    </div>
  )
}
