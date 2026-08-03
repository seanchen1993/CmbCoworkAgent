import { useCallback, useEffect, useState } from "react"
import {
  BadgeCheck,
  Blocks,
  BookOpen,
  Bug,
  ClipboardList,
  Compass,
  Crosshair,
  FileSearch,
  FlaskConical,
  Gavel,
  GitBranch,
  Hammer,
  Loader2,
  Lock,
  Map as MapIcon,
  Microscope,
  Palette,
  PenLine,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Telescope,
  Terminal,
  Users,
  Wand2,
  type LucideIcon
} from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import type {
  ExpertAgentAccess,
  ExpertAgentEntry
} from "../../../../shared/expert-agent-types"

/** UI 展示层的专家档案。registry 里的英文 description 是给模型看的原文，
 * 这里是给人看的策展信息。 */
interface ExpertMeta {
  /** 中文头衔 */
  title: string
  /** 一句话定位 */
  tagline: string
  /** 什么时候找它 */
  whenToUse: string[]
  /** 它会怎么干 */
  how: string[]
  /** 交付什么 */
  delivers: string
  icon: LucideIcon
}

const EXPERT_META: Record<string, ExpertMeta> = {
  Explore: {
    title: "代码侦察兵",
    tagline: "快速摸清代码库：找文件、搜实现、答结构问题",
    whenToUse: ["找某个功能的实现位置", "梳理模块结构和调用关系", "确认某种模式在哪些地方出现"],
    how: [
      "glob 按模式圈定文件，grep 正则搜内容，并行展开",
      "按调用方指定的彻底程度（快速/中等/地毯式）调节搜索广度",
      "严格只读——不创建、不修改、不运行有副作用的命令"
    ],
    delivers: "检索报告：关键文件定位 + 相关代码摘录",
    icon: Telescope
  },
  Plan: {
    title: "方案规划师",
    tagline: "动手之前，先探索代码库并产出分步实现计划",
    whenToUse: ["改动涉及多个模块，需要先想清楚", "想比较不同实现路径的取舍", "希望列出关键文件再动手"],
    how: [
      "先读现有代码：找同类特性、既有约定、架构模式",
      "基于真实代码事实设计方案，权衡取舍",
      "输出分步骤计划，标出 3-5 个最关键的文件"
    ],
    delivers: "分步实现计划 + 关键文件清单",
    icon: MapIcon
  },
  verification: {
    title: "验收官",
    tagline: "不是确认能跑，而是想办法把实现搞坏",
    whenToUse: ["非平凡改动完成后、上报前", "怀疑实现只覆盖了 happy path", "要一份带证据的完成度判决"],
    how: [
      "跑构建、测试套件、类型检查——红了直接 FAIL",
      "按改动类型定制验证：起服务打接口、跑 CLI、复现原 bug",
      "对抗性探测：并发、边界值、幂等性、孤儿操作",
      "每项检查必须附命令和真实输出，读代码不算验证"
    ],
    delivers: "VERDICT: PASS / FAIL / PARTIAL + 逐项证据",
    icon: BadgeCheck
  },
  "general-purpose": {
    title: "多面手",
    tagline: "通用子代理：复杂问题研究与多步任务执行",
    whenToUse: ["任务不属于任何专家的领域", "搜索没把握一次命中，想让代理多试几轮", "需要研究+执行混合的长任务"],
    how: ["拥有与主代理一致的完整工具集", "自主探索、执行、汇报"],
    delivers: "任务结果与过程说明",
    icon: Blocks
  },
  analyst: {
    title: "需求分析师",
    tagline: "规划开始前，把需求里的坑先挖出来",
    whenToUse: ["需求描述模糊、边界不清", "担心做出来的东西不是用户想要的", "要把口头需求变成可验收的标准"],
    how: [
      "逐条检查需求：完整吗？可测试吗？有歧义吗？",
      "列出没人问过的问题，标注每个假设和验证方法",
      "圈出容易蔓延的范围，定义明确的验收标准"
    ],
    delivers: "缺口清单 + 可测试（pass/fail）的验收标准",
    icon: ClipboardList
  },
  architect: {
    title: "架构顾问",
    tagline: "只读深度分析：根因诊断与带证据的架构建议",
    whenToUse: ["架构决策拿不定主意", "复杂 bug 需要根因而不是表象修补", "反复修不好，怀疑问题在别处"],
    how: [
      "先读代码再下结论，每个论断带 file:line 证据",
      "调试类问题：读完整报错 → git log/blame 查变更史 → 对比可用例",
      "建议分优先级，每条附带权衡（得到什么、牺牲什么）"
    ],
    delivers: "根因分析 + 分优先级建议 + 权衡表（不动手改码）",
    icon: Compass
  },
  critic: {
    title: "评审官",
    tagline: "最后一道质量闸门：假批准的代价是假拒绝的十倍",
    whenToUse: ["计划定稿前的把关", "重要成果提交前想要苛刻的审视", "想知道方案里'没写的'比'写了的'缺什么"],
    how: [
      "先预判最可能出问题的 3-5 处，再逐一验证",
      "核实每个文件引用和技术论断，模拟执行每一步",
      "多视角轮审（安全/新人/运维 或 执行者/干系人/怀疑者）",
      "自审校准：低置信度的发现降级为开放问题，不虚张声势"
    ],
    delivers: "REJECT / REVISE / ACCEPT 判决 + 按严重度分级的发现",
    icon: Gavel
  },
  "code-reviewer": {
    title: "代码评审",
    tagline: "规格符合性优先的系统化分级评审",
    whenToUse: ["改动完成，想要独立的第二双眼睛", "关注逻辑正确性、错误处理、性能", "API/IPC 接口变更要查破坏性"],
    how: [
      "第一阶段先查规格符合性：做的是不是要求的事",
      "第二阶段跑类型检查/linter，过检查清单：安全、逻辑、性能",
      "每条发现带 severity×confidence 双评级和具体修法",
      "发现全量上报，过滤交给下游——宁可多报不可漏报"
    ],
    delivers: "APPROVE / REQUEST CHANGES / COMMENT + 逐条 file:line 修法",
    icon: FileSearch
  },
  "security-reviewer": {
    title: "安全审计",
    tagline: "OWASP Top 10 全项检查 + 密钥扫描 + 依赖审计",
    whenToUse: ["涉及用户输入、鉴权、数据库查询的改动", "依赖升级后想查已知漏洞", "上线前的安全把关"],
    how: [
      "密钥扫描（硬编码 key/password/token）+ git 历史检查",
      "npm audit / pip-audit 等依赖审计",
      "OWASP 逐项过：注入、鉴权、敏感数据、访问控制、XSS…",
      "按 严重度×可利用性×爆炸半径 排序，先修最危险的"
    ],
    delivers: "风险分级报告，每条带同语言的安全代码示例",
    icon: ShieldCheck
  },
  "code-simplifier": {
    title: "代码简化师",
    tagline: "行为一丝不变，只让代码更清晰、更像这个项目",
    whenToUse: ["功能写完想让代码更清爽", "刚合入的代码嵌套深、有重复", "想统一新代码与项目既有风格"],
    how: [
      "只动结构不动行为：不改导出、不改签名、不改控制流语义",
      "先读周边代码和 lint 配置，改完像团队自己写的",
      "存疑就不动——拿不准是否保持行为时保持原样",
      "改完跑类型检查/测试验证零新增错误"
    ],
    delivers: "简化清单 + 跳过说明 + 验证结果",
    icon: Wand2
  },
  debugger: {
    title: "排障专家",
    tagline: "先复现、单假设、最小 diff——修根因不修表象",
    whenToUse: ["有具体报错或栈追踪", "构建红了要尽快转绿", "回归问题要定位引入点"],
    how: [
      "先复现再排查；读完整报错，每个词都有信息",
      "git blame/log 找引入点，对比可用版本找差异",
      "一次只验证一个假设，3 次失败就停下重新审视",
      "最小 diff 修复，顺手查同类模式是否也有此问题"
    ],
    delivers: "根因报告（症状/根因/复现/修复/验证）+ 已验证的最小修复",
    icon: Bug
  },
  tracer: {
    title: "因果侦探",
    tagline: "解释'为什么会这样'：竞争假设 + 证据分级 + 反证",
    whenToUse: ["现象诡异，有好几种可能解释", "想区分真相关和巧合", "修之前先要一个站得住的解释"],
    how: [
      "观察与解读严格分离，先精确陈述看到了什么",
      "生成多个竞争假设，为每个收集支持与反对证据",
      "证据按强度分级：可控复现 > 一手工件 > 推断 > 直觉",
      "指出最关键的未知项和最能收敛不确定性的下一步探针"
    ],
    delivers: "假设排名表 + 当前最佳解释 + 判别性探针建议",
    icon: Crosshair
  },
  "qa-tester": {
    title: "交互测试员",
    tagline: "真实跑起来测：tmux 起服务、发命令、抓输出断言",
    whenToUse: ["单测全绿但想验证真实运行行为", "CLI/服务的交互流程要过一遍", "启动失败、集成问题这类单测测不到的"],
    how: [
      "先验前置条件：tmux 可用、端口空闲、目录存在",
      "tmux 起服务 → 轮询就绪信号 → 发命令 → capture-pane 抓真实输出",
      "断言基于抓到的输出，不靠想象",
      "无论成败都清理会话，不留孤儿进程"
    ],
    delivers: "逐用例报告：命令/预期/实际/PASS-FAIL + 清理确认",
    icon: Terminal
  },
  executor: {
    title: "实现执行者",
    tagline: "方案已定时的精确落地：最小可行 diff",
    whenToUse: ["改动方案明确，需要可靠执行", "多文件改动要一步步稳妥推进", "不想要'顺手重构'的额外惊喜"],
    how: [
      "先探索：这个项目怎么命名、怎么处理错误、测试长什么样",
      "最小可行变更，不为单次使用引入新抽象",
      "每步改完即验证，最后跑完整构建/测试",
      "绝不 scope creep——相邻代码的问题汇报但不顺手改"
    ],
    delivers: "变更清单（file:line）+ 新鲜的构建/测试证据",
    icon: Hammer
  },
  designer: {
    title: "UI 设计开发",
    tagline: "有审美主张的界面实现，拒绝'AI 味'的平庸设计",
    whenToUse: ["新页面/组件想要有设计感", "现有界面平淡想改版", "运营型界面（面板/工具）要专业观感"],
    how: [
      "写码前先定审美方向：目的、基调、差异化的记忆点",
      "按领域适配：仪表盘/工具类界面用克制专业的方向",
      "研究项目现有组件与样式约定，融入而不突兀",
      "实现后验证渲染、响应式、可访问性"
    ],
    delivers: "生产级组件 + 设计决策说明（字体/配色/动效/布局）",
    icon: Palette
  },
  "test-engineer": {
    title: "测试工程师",
    tagline: "测试策略、flaky 治理与 TDD 红绿重构",
    whenToUse: ["新功能要补测试覆盖", "有测试时好时坏（flaky）", "想用 TDD 方式推进开发"],
    how: [
      "先读既有测试摸清框架与命名惯例，融入而非另起炉灶",
      "一个测试只验一个行为，名字说清预期",
      "flaky 修根因（共享状态/时序），不加 sleep 掩盖",
      "TDD 铁律：没有先失败的测试就没有生产代码"
    ],
    delivers: "可运行的测试 + 覆盖缺口分析（带风险分级）",
    icon: FlaskConical
  },
  writer: {
    title: "文档作者",
    tagline: "README、API 文档、注释——示例全部实测过",
    whenToUse: ["新模块要写 README/使用文档", "API 文档要和真实行为对齐", "文档过时需要按代码现状重写"],
    how: [
      "读真实代码再动笔，绝不凭记忆编接口",
      "每个代码示例、每条命令都实际运行验证",
      "匹配项目既有文档的风格与结构",
      "结构化排版：标题、代码块、表格，可扫读"
    ],
    delivers: "验证过的文档 + 示例/命令验证记录",
    icon: PenLine
  },
  scientist: {
    title: "数据科学家",
    tagline: "统计严谨的数据分析：没有置信区间的结论是猜测",
    whenToUse: ["数据文件要探索分析", "假设需要统计检验", "性能/度量数据要下结论"],
    how: [
      "假设驱动：先陈述假设，再检验，再报告",
      "Python 脚本跑在临时目录，绝不碰项目文件",
      "每个发现必须带统计量：置信区间、效应量、p 值、样本量",
      "明确列出局限：缺失数据、样本偏差、混杂因素"
    ],
    delivers: "结构化报告：OBJECTIVE / DATA / FINDING+STAT / LIMITATION",
    icon: Microscope
  },
  "git-master": {
    title: "Git 专家",
    tagline: "原子提交、风格匹配、安全变基的历史管理",
    whenToUse: ["一堆改动要拆成可回滚的原子提交", "变基/历史整理不敢自己动手", "提交信息要匹配项目惯例"],
    how: [
      "先分析最近 30 条提交，探测语言与格式惯例",
      "按关注点拆分：配置/逻辑/测试/文档各自成提交",
      "只做明确要求的写操作；变基前 stash -u 保护未跟踪文件",
      "--force-with-lease 而非 --force，绝不动 main"
    ],
    delivers: "原子提交序列 + git log 验证输出",
    icon: GitBranch
  },
  "document-specialist": {
    title: "文档研究员",
    tagline: "查资料必带可核实的引用，本地文档优先",
    whenToUse: ["查 API/框架的正确用法", "版本兼容性确认", "技术选型要可靠依据"],
    how: [
      "项目相关问题先查本地 README/docs/迁移说明",
      "外部问题用会话可用的文档/网络工具，官方源优先",
      "每个结论标注来源与版本，过时信息明确标记",
      "只读运行——研究结论直接在回复中交付"
    ],
    delivers: "带引用的研究结论 + 可运行的代码示例",
    icon: BookOpen
  }
}

const FALLBACK_META: ExpertMeta = {
  title: "专家",
  tagline: "",
  whenToUse: [],
  how: [],
  delivers: "",
  icon: Sparkles
}

/** 专家库分组（仅 UI 展示层的组织方式），带分类色。 */
const LIBRARY_GROUPS: Array<{
  label: string
  names: string[]
  accent: { icon: string; dot: string }
}> = [
  {
    label: "规划与咨询",
    names: ["analyst", "architect", "critic"],
    accent: { icon: "bg-violet-500/10 text-violet-600 dark:text-violet-400", dot: "bg-violet-500" }
  },
  {
    label: "质量与安全",
    names: ["code-reviewer", "security-reviewer", "code-simplifier"],
    accent: { icon: "bg-rose-500/10 text-rose-600 dark:text-rose-400", dot: "bg-rose-500" }
  },
  {
    label: "排障与验证",
    names: ["debugger", "tracer", "qa-tester"],
    accent: { icon: "bg-sky-500/10 text-sky-600 dark:text-sky-400", dot: "bg-sky-500" }
  },
  {
    label: "开发实现",
    names: ["executor", "designer", "test-engineer", "writer"],
    accent: {
      icon: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      dot: "bg-emerald-500"
    }
  },
  {
    label: "数据与工具",
    names: ["scientist", "git-master", "document-specialist"],
    accent: { icon: "bg-amber-500/10 text-amber-600 dark:text-amber-400", dot: "bg-amber-500" }
  }
]

const BUILT_IN_ACCENT = { icon: "bg-primary/10 text-primary", dot: "bg-primary" }
const FALLBACK_ACCENT = { icon: "bg-muted text-muted-foreground", dot: "bg-muted-foreground" }

function accentFor(agent: ExpertAgentEntry): { icon: string; dot: string } {
  if (agent.builtIn) return BUILT_IN_ACCENT
  return LIBRARY_GROUPS.find((g) => g.names.includes(agent.name))?.accent ?? FALLBACK_ACCENT
}

const ACCESS_META: Record<ExpertAgentAccess, { label: string; className: string; detail: string }> =
  {
    read_only: {
      label: "只读",
      className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      detail: "只能读取代码和执行只读命令（ls、git log、grep…），无法创建或修改任何文件。"
    },
    verify: {
      label: "禁编辑·可执行",
      className: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
      detail:
        "已禁用 write_file / edit_file 编辑工具，但保留完整 shell（execute）：可跑测试、构建、审计等命令。注意：理论上仍能通过 shell 命令改动文件，此边界由命令审批流把关，而非硬性只读——适合验证类而非可信隔离场景。"
    },
    full: {
      label: "完全访问",
      className: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
      detail: "完整工具集：读写文件与执行命令，与主代理一致（仍受会话审批流约束）。"
    }
  }

function AccessBadge({ access }: { access: ExpertAgentAccess }): React.JSX.Element {
  const meta = ACCESS_META[access]
  return (
    <span
      className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium", meta.className)}
    >
      {meta.label}
    </span>
  )
}

function ExpertCard(props: {
  agent: ExpertAgentEntry
  pending: boolean
  onToggle: (name: string, enabled: boolean) => void
  onOpen: (agent: ExpertAgentEntry) => void
}): React.JSX.Element {
  const { agent, pending, onToggle, onOpen } = props
  const meta = EXPERT_META[agent.name] ?? FALLBACK_META
  const accent = accentFor(agent)
  const Icon = meta.icon
  const active = agent.builtIn || agent.enabled

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(agent)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onOpen(agent)
      }}
      className={cn(
        "group flex cursor-pointer flex-col gap-2.5 rounded-xl border p-3.5 text-left transition-all",
        active
          ? "border-border bg-background shadow-sm hover:shadow-md"
          : "border-border/50 bg-muted/20 hover:border-border hover:bg-background",
        pending && "pointer-events-none opacity-60"
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg transition-opacity",
            accent.icon,
            !active && "opacity-50 grayscale-[35%]"
          )}
        >
          <Icon className="size-4.5" strokeWidth={1.8} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "truncate text-sm font-semibold",
                active ? "text-foreground" : "text-muted-foreground"
              )}
            >
              {meta.title}
            </span>
            <span className="truncate font-mono text-[10px] text-muted-foreground/70">
              {agent.name}
            </span>
          </div>
          <p
            className={cn(
              "mt-0.5 line-clamp-2 text-xs leading-relaxed",
              active ? "text-muted-foreground" : "text-muted-foreground/70"
            )}
          >
            {meta.tagline || agent.description}
          </p>
        </div>
        <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
          {agent.builtIn ? (
            <span className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
              <Lock className="size-3" />
              内置
            </span>
          ) : (
            <Switch
              checked={agent.enabled}
              disabled={pending}
              onCheckedChange={(checked) => onToggle(agent.name, checked)}
            />
          )}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <AccessBadge access={agent.access} />
        {meta.whenToUse[0] && (
          <span className="truncate text-[10px] text-muted-foreground/70">
            适用：{meta.whenToUse[0]}
          </span>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground/50 opacity-0 transition-opacity group-hover:opacity-100">
          点击查看详情
        </span>
      </div>
    </div>
  )
}

function ExpertDetailDialog(props: {
  agent: ExpertAgentEntry | null
  pending: boolean
  onToggle: (name: string, enabled: boolean) => void
  onClose: () => void
}): React.JSX.Element {
  const { agent, pending, onToggle, onClose } = props
  const meta = agent ? (EXPERT_META[agent.name] ?? FALLBACK_META) : FALLBACK_META
  const accent = agent ? accentFor(agent) : FALLBACK_ACCENT
  const Icon = meta.icon

  return (
    <Dialog open={agent !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] gap-0 overflow-y-auto sm:max-w-[520px]">
        {agent && (
          <>
            <DialogHeader className="space-y-3">
              <div className="flex items-center gap-3.5">
                <div
                  className={cn(
                    "flex size-12 shrink-0 items-center justify-center rounded-xl",
                    accent.icon
                  )}
                >
                  <Icon className="size-6" strokeWidth={1.8} />
                </div>
                <div className="min-w-0 flex-1">
                  <DialogTitle className="flex items-center gap-2 text-base">
                    {meta.title}
                    <span className="font-mono text-xs font-normal text-muted-foreground">
                      {agent.name}
                    </span>
                  </DialogTitle>
                  <DialogDescription className="mt-1 text-xs leading-relaxed">
                    {meta.tagline || agent.description}
                  </DialogDescription>
                </div>
                <div className="shrink-0">
                  {agent.builtIn ? (
                    <span className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-[10px] text-muted-foreground">
                      <Lock className="size-3" />
                      始终启用
                    </span>
                  ) : (
                    <Switch
                      checked={agent.enabled}
                      disabled={pending}
                      onCheckedChange={(checked) => onToggle(agent.name, checked)}
                    />
                  )}
                </div>
              </div>
            </DialogHeader>

            <div className="mt-4 space-y-4">
              {meta.whenToUse.length > 0 && (
                <section>
                  <h4 className="mb-1.5 text-xs font-semibold text-foreground">什么时候找它</h4>
                  <ul className="space-y-1">
                    {meta.whenToUse.map((item) => (
                      <li key={item} className="flex gap-2 text-xs leading-relaxed text-muted-foreground">
                        <span className={cn("mt-1.5 size-1 shrink-0 rounded-full", accent.dot)} />
                        {item}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {meta.how.length > 0 && (
                <section>
                  <h4 className="mb-1.5 text-xs font-semibold text-foreground">它会怎么干</h4>
                  <ul className="space-y-1">
                    {meta.how.map((item) => (
                      <li key={item} className="flex gap-2 text-xs leading-relaxed text-muted-foreground">
                        <span className={cn("mt-1.5 size-1 shrink-0 rounded-full", accent.dot)} />
                        {item}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {meta.delivers && (
                <section>
                  <h4 className="mb-1.5 text-xs font-semibold text-foreground">交付什么</h4>
                  <p className="text-xs leading-relaxed text-muted-foreground">{meta.delivers}</p>
                </section>
              )}

              <section className="rounded-lg border border-border/60 bg-muted/30 p-3">
                <div className="flex items-center gap-2">
                  <h4 className="text-xs font-semibold text-foreground">权限边界</h4>
                  <AccessBadge access={agent.access} />
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  {ACCESS_META[agent.access].detail}
                </p>
              </section>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function ExpertTeamPanel(): React.JSX.Element {
  const [agents, setAgents] = useState<ExpertAgentEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [pendingName, setPendingName] = useState<string | null>(null)
  const [detailName, setDetailName] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const list = await window.api.expertAgents.list()
      setAgents(list)
    } catch (error) {
      console.error("[ExpertTeamPanel] load failed:", error)
      toast.error("专家团列表加载失败")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleToggle = useCallback(async (name: string, enabled: boolean): Promise<void> => {
    setPendingName(name)
    // 乐观更新；失败时仅回滚本行。主进程串行处理请求，无需全量 reconcile——
    // 用响应快照重写所有行反而会把其他行更新的在途状态翻回去。
    setAgents((prev) => prev.map((a) => (a.name === name ? { ...a, enabled } : a)))
    try {
      await window.api.expertAgents.setEnabled(name, enabled)
    } catch (error) {
      console.error("[ExpertTeamPanel] toggle failed:", error)
      toast.error(`${enabled ? "启用" : "停用"} ${name} 失败`)
      setAgents((prev) => prev.map((a) => (a.name === name ? { ...a, enabled: !enabled } : a)))
    } finally {
      // 只清除仍属于本次请求的守卫，别把后续切换的在途状态清掉。
      setPendingName((prev) => (prev === name ? null : prev))
    }
  }, [])

  const builtIns = agents.filter((a) => a.builtIn)
  const library = agents.filter((a) => !a.builtIn)
  const libraryByName = new Map(library.map((a) => [a.name, a]))
  const groupedNames = new Set(LIBRARY_GROUPS.flatMap((g) => g.names))
  const ungrouped = library.filter((a) => !groupedNames.has(a.name))
  const enabledLibraryCount = library.filter((a) => a.enabled).length
  const detailAgent = detailName ? (agents.find((a) => a.name === detailName) ?? null) : null

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-md border border-border bg-muted/40">
            <Users className="size-4 text-primary" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-foreground">专家团</h2>
            <p className="text-xs text-muted-foreground">
              主代理可按需委派的专家子代理，开关下一次对话生效
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">
            已启用 <span className="font-semibold text-foreground">{enabledLibraryCount}</span>/
            {library.length}
          </span>
          <Button variant="ghost" size="sm" className="h-8 gap-1.5" onClick={() => void load()}>
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            刷新
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-7 overflow-y-auto px-6 py-5">
        {loading && agents.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            <span className="text-sm">加载中…</span>
          </div>
        ) : (
          <>
            <section className="space-y-3">
              <div className="flex items-center gap-2">
                <span className={cn("size-1.5 rounded-full", BUILT_IN_ACCENT.dot)} />
                <h3 className="text-xs font-semibold tracking-wide text-foreground">内置专家</h3>
                <span className="text-[10px] text-muted-foreground">始终可用</span>
              </div>
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                {builtIns.map((agent) => (
                  <ExpertCard
                    key={agent.name}
                    agent={agent}
                    pending={pendingName === agent.name}
                    onToggle={handleToggle}
                    onOpen={(a) => setDetailName(a.name)}
                  />
                ))}
              </div>
            </section>

            {LIBRARY_GROUPS.map((group) => {
              const items = group.names
                .map((n) => libraryByName.get(n))
                .filter((a): a is ExpertAgentEntry => Boolean(a))
              if (items.length === 0) return null
              return (
                <section key={group.label} className="space-y-3">
                  <div className="flex items-center gap-2">
                    <span className={cn("size-1.5 rounded-full", group.accent.dot)} />
                    <h3 className="text-xs font-semibold tracking-wide text-foreground">
                      {group.label}
                    </h3>
                    <span className="text-[10px] text-muted-foreground">
                      {items.filter((a) => a.enabled).length}/{items.length} 已启用
                    </span>
                  </div>
                  <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                    {items.map((agent) => (
                      <ExpertCard
                        key={agent.name}
                        agent={agent}
                        pending={pendingName === agent.name}
                        onToggle={handleToggle}
                        onOpen={(a) => setDetailName(a.name)}
                      />
                    ))}
                  </div>
                </section>
              )
            })}

            {ungrouped.length > 0 && (
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className={cn("size-1.5 rounded-full", FALLBACK_ACCENT.dot)} />
                  <h3 className="text-xs font-semibold tracking-wide text-foreground">其他</h3>
                </div>
                <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                  {ungrouped.map((agent) => (
                    <ExpertCard
                      key={agent.name}
                      agent={agent}
                      pending={pendingName === agent.name}
                      onToggle={handleToggle}
                      onOpen={(a) => setDetailName(a.name)}
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>

      <ExpertDetailDialog
        agent={detailAgent}
        pending={detailAgent ? pendingName === detailAgent.name : false}
        onToggle={handleToggle}
        onClose={() => setDetailName(null)}
      />
    </div>
  )
}
