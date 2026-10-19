export function CreatorWorkspaceNavigation({
  onNavigate,
  currentStep = "create"
}: {
  onNavigate(target: "create" | "trial" | "acceptance" | "delivery"): void
  currentStep?: "create" | "trial" | "acceptance" | "delivery"
}) {
  const steps = [
    { target: "create", title: "1 · 制作与修改", hint: "返回原聊天描述需求" },
    { target: "trial", title: "2 · 运行试用", hint: "配置并启动当前版本" },
    { target: "acceptance", title: "3 · 验收结果", hint: "查看阶段、产物和校验" },
    { target: "delivery", title: "4 · 保存为插件", hint: "安装使用或导出分享" }
  ] as const
  return (
    <nav className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="插件制作步骤">
      {steps.map((step) => (
        <button
          key={step.target}
          type="button"
          aria-current={currentStep === step.target ? "step" : undefined}
          className={`rounded-lg border p-3 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${currentStep === step.target ? "border-primary/40 bg-primary/5" : "bg-background"}`}
          onClick={() => onNavigate(step.target)}
        >
          <span className="block text-sm font-medium">{step.title}</span>
          <span className="mt-1 block text-xs text-muted-foreground">{step.hint}</span>
        </button>
      ))}
    </nav>
  )
}
