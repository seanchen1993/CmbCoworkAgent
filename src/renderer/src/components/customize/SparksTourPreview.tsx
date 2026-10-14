import type { ReactNode } from "react"

export interface SparksTourPreviewProps {
  chapter: number
  stage: number
  scenario: string
  sources: readonly string[]
  name: string
}

const cardClass = "min-w-0 rounded-lg border bg-background p-2.5"
const labelClass = "text-[11px] text-muted-foreground"
const badgeClass = "rounded border bg-muted px-2 py-1 text-[11px]"

function Card({ title, children }: { title: string; children: ReactNode }): React.JSX.Element {
  return (
    <section className={cardClass} aria-label={title}>
      <h4 className="mb-2 text-xs font-medium">{title}</h4>
      {children}
    </section>
  )
}

function Bubble({ who, children }: { who: string; children: ReactNode }): React.JSX.Element {
  return (
    <div
      className={
        who === "你" ? "ml-5 rounded-lg bg-primary/10 p-2" : "mr-5 rounded-lg bg-muted p-2"
      }
    >
      <div className={labelClass}>{who}</div>
      <div className="mt-1 text-xs leading-5">{children}</div>
    </div>
  )
}

function Node({
  number,
  title,
  state
}: {
  number: number
  title: string
  state: string
}): React.JSX.Element {
  return (
    <li className="flex items-start gap-2 rounded-md border bg-background p-2">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs">
        {number}
      </span>
      <div className="min-w-0 flex-1 text-xs">{title}</div>
      <span className="max-w-[45%] text-right text-[11px] text-muted-foreground">{state}</span>
    </li>
  )
}

/** A local visual teaching fixture. No subscriptions, timers, APIs or executable controls. */
export function SparksTourPreview({
  chapter,
  stage,
  scenario,
  sources,
  name
}: SparksTourPreviewProps): React.JSX.Element {
  const displayName = name.trim() || "新朋友"
  const recovering = scenario !== "success"
  const failed = recovering && stage >= 2
  const secondRun = recovering && stage >= 5
  const readingState = secondRun
    ? stage === 5
      ? "重新读取中"
      : "已重新读取"
    : failed
      ? "失败 · 已停止"
      : stage >= 3
        ? "已读取"
        : stage === 2
          ? "读取中"
          : "等待启动"
  const reviewingState = secondRun
    ? stage === 5
      ? "等待新资料"
      : "已返回意见"
    : failed
      ? "未执行"
      : stage >= 3
        ? "已返回意见"
        : "等待前一步"
  let content: ReactNode

  switch (chapter) {
    case 0:
      content = (
        <div className="grid gap-2 sm:grid-cols-2">
          <Card title="练习项目 · 购物车">
            <div className="rounded border bg-muted/40 p-2 font-mono text-xs">
              <div>DEMO-001</div>
              <div className="mt-1">src/cart.ts</div>
              <code className="mt-2 block">items[0].name</code>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              <span className={badgeClass}>{stage >= 1 ? "Autobiz · 读取" : "需求文件"}</span>
              <span className={badgeClass}>{stage >= 1 ? "Review · 检视" : "空列表场景"}</span>
            </div>
          </Card>
          <Card title="聊天预览">
            <div className="space-y-2">
              <div className={labelClass}>
                当前搭配：{stage >= 2 ? "购物车检视助手" : "尚未应用"}
              </div>
              <Bubble who="你">检查空购物车会不会报错</Bubble>
              {stage >= 3 ? (
                <Bubble who="示例助手">发现风险：先判断列表是否为空。</Bubble>
              ) : (
                <div className="rounded border border-dashed p-2 text-xs">尚未开始检视</div>
              )}
            </div>
          </Card>
        </div>
      )
      break
    case 1:
      content = (
        <Card
          title={
            stage === 0
              ? "挑选使用 · 官方灵件"
              : stage === 1
                ? "核对显示位置"
                : "修改回放 · 示例文件"
          }
        >
          {stage < 2 ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <div className="rounded-lg border border-primary/40 bg-primary/5 p-3">
                <div className="text-sm font-medium">↶ 修改回放</div>
                <div className="mt-1 text-xs">回看改前与改后</div>
                <div className="mt-2 text-[11px]">
                  {stage === 0 ? "等待你选择" : "待确认使用 · 不自动授权"}
                </div>
              </div>
              <div className="rounded-lg border border-dashed p-3 text-xs">
                <div>聊天输入框上方</div>
                <div className="my-2 rounded bg-muted p-2">☀ 用量天气</div>
                <div>{stage === 0 ? "一个显示位置" : "切换为修改回放前须确认替换"}</div>
              </div>
            </div>
          ) : (
            <div>
              <div className="mb-2 flex flex-wrap justify-between gap-1 text-[11px]">
                <span>button.tsx</span>
                <span>{stage === 2 ? "编辑审批待核对" : "示例回放面板 · 1 处修改"}</span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded border p-2">
                  <div className={labelClass}>改前</div>
                  <code className="mt-2 block bg-destructive/10 p-2 text-xs">− 提交</code>
                </div>
                <div className="rounded border p-2">
                  <div className={labelClass}>{stage === 2 ? "拟改为" : "改后"}</div>
                  <code className="mt-2 block bg-primary/10 p-2 text-xs">+ 保存</code>
                </div>
              </div>
            </div>
          )}
        </Card>
      )
      break
    case 2:
      content = (
        <Card title="助手组合 · 购物车检视助手">
          <div className="grid gap-2 sm:grid-cols-2">
            {["Autobiz · 跨插件检视输入", "独立 Review · 整个插件"].map((source, index) => (
              <div key={source} className="rounded border p-2">
                <div className="text-xs">
                  {sources.includes(source) ? "☑" : "☐"} {source}
                </div>
                <div className="mt-2 text-[11px] text-muted-foreground">
                  {index === 0 ? "提供资料" : "给出检视意见"}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded bg-muted p-2">组合库：{stage >= 1 ? "已模拟保存" : "草稿"}</div>
            <div className="rounded bg-primary/10 p-2">
              当前聊天：{stage >= 2 ? "已模拟应用" : "保持原设置"}
            </div>
          </div>
          {stage === 3 && (
            <div className="mt-2 rounded border border-dashed p-2 text-xs">
              下一步：安排两个步骤，再发送任务
            </div>
          )}
        </Card>
      )
      break
    case 3:
      content = (
        <Card title="运行过程 · 两步检视">
          <ol className="space-y-2" aria-label="演示流程节点">
            <Node number={1} title="Autobiz · 读取当前文件" state={readingState} />
            <li className="pl-7 text-[11px] text-muted-foreground">
              ↓ {stage >= 1 ? "传给下一步：文件路径、内容和需求背景" : "DEMO-001 / src/cart.ts"}
            </li>
            <Node number={2} title="独立 Review · 检视资料" state={reviewingState} />
          </ol>
          {failed && (
            <div className="mt-2 rounded border border-destructive/30 bg-destructive/5 p-2 text-xs">
              <div>第 1 轮 · 失败记录保留</div>
              <div className="mt-1">
                {scenario === "denied" ? "读取权限未获批准" : "读取时需求内容发生了变化"}
                ，后续检视未执行。
              </div>
              {stage === 3 && (
                <div className="mt-1">
                  排查：{scenario === "denied" ? "项目、文件、授权" : "需求版本与文件"}
                </div>
              )}
              {stage === 4 && <div className="mt-1">演示：问题已处理，接下来重新运行</div>}
            </div>
          )}
          {secondRun && (
            <div className="mt-2 rounded border bg-primary/5 p-2 text-xs">
              第 2 轮 · {stage === 5 ? "重新验证中" : "发现空列表风险，还需修复和测试"}
            </div>
          )}
          {!recovering && stage === 3 && (
            <div className="mt-2 rounded border p-2 text-xs">
              意见：访问第一项前判断长度。未运行测试。
            </div>
          )}
        </Card>
      )
      break
    case 4:
      content = (
        <div className="grid gap-2 sm:grid-cols-2">
          <Card title="自己制作 · 问候命令">
            <div className="rounded border bg-muted/40 p-2 text-xs">
              需求：输入名字，返回一句问候
            </div>
            {stage >= 1 && (
              <div className="mt-2 rounded border p-2 font-mono text-xs">
                <div>hello-spark</div>
                <div className="mt-1">名字 → 问候文字</div>
                <div className="mt-2 font-sans text-muted-foreground">
                  这里只演示样子，尚未创建插件
                </div>
              </div>
            )}
          </Card>
          <Card title={stage < 2 ? "试用区 · 等待核对" : "命令回复预览"}>
            <div className="space-y-2">
              <div className="rounded border p-2 font-mono text-xs">/hello-spark {displayName}</div>
              {stage === 3 ? (
                <Bubble who="示例命令">回复内容：你好，{displayName}！第一个灵件已运行。</Bubble>
              ) : (
                <div className="rounded border border-dashed p-2 text-xs">
                  {stage === 2 ? "已模拟启用，等待发送命令" : "实际试用前，先确认插件要使用的权限"}
                </div>
              )}
            </div>
          </Card>
        </div>
      )
      break
    case 5:
      content = (
        <Card title="效果测试 · 用同一个问题比较">
          <div className="mb-2 rounded bg-muted p-2 font-mono text-xs">
            items = [] · 检查访问 items[0]
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {["A · 原流程", "B · 增加空列表要求"].map((version, index) => (
              <div key={version} className="rounded border p-2">
                <div className="text-xs font-medium">{version}</div>
                <div className="mt-2 text-xs leading-5">
                  {stage < 1
                    ? "尚未选择版本"
                    : stage < 2
                      ? "示例版本已选，下一步比较回答"
                      : index === 0
                        ? "预设回答：建议补注释"
                        : "预设回答：先判断空列表"}
                </div>
                {stage === 3 && (
                  <div className="mt-2 rounded bg-primary/10 p-2 text-[11px]">
                    {index === 0 ? "未提及本例风险" : "提及本例风险 · 尚未应用"}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )
      break
    default:
      content = (
        <Card title="当前助手 · 购物车检视助手">
          <div className="mb-2 flex flex-wrap gap-2 text-xs">
            <span className={stage < 2 ? "rounded bg-primary/10 px-2 py-1" : badgeClass}>设置</span>
            <span className={stage >= 2 ? "rounded bg-primary/10 px-2 py-1" : badgeClass}>
              运行过程
            </span>
          </div>
          {stage === 0 ? (
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded border p-2">资料：Autobiz</div>
              <div className="rounded border p-2">检视：Review</div>
            </div>
          ) : stage === 1 ? (
            <div className="space-y-2">
              <Bubble who="你">检查购物车文件的空列表处理</Bubble>
              <div className={badgeClass}>发送方式：按步骤执行 · 尚未发送</div>
            </div>
          ) : (
            <ol className="space-y-2">
              <Node number={1} title="读取" state="示例已完成" />
              <Node number={2} title="检视" state="发现风险" />
              <Node number={3} title="项目阶段验收" state="尚未执行" />
            </ol>
          )}
          {stage === 2 && (
            <div className="mt-2 rounded border border-dashed p-2 text-xs">
              插件面板入口：回放 · 看板（仅有面板的插件显示）
            </div>
          )}
          {stage === 3 && (
            <div className="mt-2 rounded bg-muted p-2 text-xs">
              接下来：修复问题 → 重新检查 → 完成原项目检查与确认
            </div>
          )}
        </Card>
      )
  }

  return (
    <div
      aria-label="示例界面预览"
      data-tour-preview="true"
      data-tour-preview-chapter={chapter}
      data-tour-preview-stage={stage}
      data-tour-preview-scenario={scenario}
      className="min-w-0 rounded-xl border bg-muted/30 p-2.5 text-foreground [overflow-wrap:anywhere]"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-1 text-[11px] text-muted-foreground">
        <span>
          示例界面 · 第 {chapter + 1} 章 / 第 {stage + 1} 步
        </span>
        <span>以下是演示，没有执行任务</span>
      </div>
      {content}
    </div>
  )
}
