export function CreatorWorkspaceNavigation({
  onNavigate,
  currentStep = "create"
}: {
  onNavigate(target: "create" | "trial" | "acceptance" | "delivery"): void
  currentStep?: "create" | "trial" | "acceptance" | "delivery"
}) {
  const steps = [
    { target: "create", title: "1 · 描述需求" },
    { target: "trial", title: "2 · 试用" },
    { target: "delivery", title: "3 · 保存插件" }
  ] as const
  return (
    <nav className="grid grid-cols-3 gap-2" aria-label="插件制作步骤">
      {steps.map((step) => (
        <button
          key={step.target}
          type="button"
          aria-current={
            (currentStep === "acceptance" ? "trial" : currentStep) === step.target
              ? "step"
              : undefined
          }
          className={`rounded-lg border px-3 py-2 text-center hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${(currentStep === "acceptance" ? "trial" : currentStep) === step.target ? "border-primary/40 bg-primary/5" : "bg-background"}`}
          onClick={() => onNavigate(step.target)}
        >
          <span className="block text-sm font-medium">{step.title}</span>
        </button>
      ))}
    </nav>
  )
}
