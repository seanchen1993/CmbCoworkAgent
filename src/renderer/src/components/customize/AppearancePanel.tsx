import { useCallback, useSyncExternalStore } from "react"
import { Check, Palette, Sparkles } from "lucide-react"
import { toast } from "sonner"
import { Switch } from "@/components/ui/switch"
import {
  getAppleIntelligenceGlowEnabled,
  setAppleIntelligenceGlowEnabled,
  subscribeAppleIntelligenceGlow
} from "@/lib/apple-intelligence-glow"
import {
  getDarkThemePreference,
  getLightThemePreference,
  getThemeModePreference,
  setThemeForColorScheme,
  setThemeModePreference,
  subscribeThemePreference,
  type ThemeModePreference,
  type ThemePreference
} from "@/lib/theme-preference"
import { DEFAULT_THEME_ID, THEME_DEFINITIONS } from "@/lib/theme-registry"
import { cn } from "@/lib/utils"

const THEME_GROUPS = [
  {
    colorScheme: "light",
    label: "浅色主题",
    themes: THEME_DEFINITIONS.filter((theme) => theme.colorScheme === "light")
  },
  {
    colorScheme: "dark",
    label: "深色主题",
    themes: THEME_DEFINITIONS.filter((theme) => theme.colorScheme === "dark")
  }
] as const

const THEME_MODE_OPTIONS: ReadonlyArray<{
  value: ThemeModePreference
  label: string
}> = [
  { value: "system", label: "系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" }
]

function ThemeModePreview({
  mode,
  selected
}: {
  mode: ThemeModePreference
  selected: boolean
}): React.JSX.Element {
  const shellBackground =
    mode === "system"
      ? "linear-gradient(90deg, #e5e5e5 0 50%, #5b5b5b 50% 100%)"
      : mode === "light"
        ? "#f1f1f1"
        : "#5b5b5b"
  const contentBackground =
    mode === "system"
      ? "linear-gradient(90deg, #ffffff 0 50%, #343434 50% 100%)"
      : mode === "dark"
        ? "#343434"
        : "#ffffff"

  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative block aspect-[1.55] overflow-hidden rounded-lg border-2",
        selected ? "border-foreground" : "border-border/70 group-hover:border-border-emphasis"
      )}
      style={{ background: shellBackground }}
    >
      <span className="absolute left-[31%] right-[20%] top-[23%] h-1.5 rounded-full bg-[#c4c4c4]" />
      <span className="absolute left-[21%] right-[12%] top-[34%] h-1 rounded-full bg-[#cfcfcf]" />
      <span
        className="absolute inset-x-[9%] bottom-0 h-[54%] overflow-hidden rounded-t-lg"
        style={{ background: contentBackground }}
      >
        <span className="absolute left-[8%] top-[20%] h-1.5 w-[28%] rounded-full bg-[#d2d2d2]" />
        <span className="absolute left-[8%] top-[38%] h-1 w-[52%] rounded-full bg-[#e2e2e2]" />
        <span className="absolute inset-x-0 top-[58%] h-px bg-[#dedede]" />
        <span className="absolute left-[8%] top-[72%] h-1.5 w-[28%] rounded-full bg-[#d2d2d2]" />
      </span>
    </span>
  )
}

export function AppearancePanel(): React.JSX.Element {
  const appleIntelligenceGlowEnabled = useSyncExternalStore(
    subscribeAppleIntelligenceGlow,
    getAppleIntelligenceGlowEnabled,
    () => false
  )
  const themeMode = useSyncExternalStore(
    subscribeThemePreference,
    getThemeModePreference,
    () => "light"
  )
  const lightThemePreference = useSyncExternalStore(
    subscribeThemePreference,
    getLightThemePreference,
    () => DEFAULT_THEME_ID
  )
  const darkThemePreference = useSyncExternalStore(
    subscribeThemePreference,
    getDarkThemePreference,
    () => "codex-dark"
  )

  const handleInputGlowChange = useCallback((enabled: boolean): void => {
    try {
      setAppleIntelligenceGlowEnabled(enabled)
      toast.success(enabled ? "输入框光效已开启" : "输入框光效已关闭")
    } catch (saveError) {
      console.error("[AppearancePanel] Failed to save input glow setting:", saveError)
      toast.error("光效设置保存失败")
    }
  }, [])

  const handleThemeChange = useCallback((theme: ThemePreference): void => {
    const definition = THEME_DEFINITIONS.find((item) => item.id === theme)
    setThemeForColorScheme(theme)
    toast.success(`已设置${definition?.colorScheme === "dark" ? "深色" : "浅色"}主题`)
  }, [])

  const handleThemeModeChange = useCallback((mode: string): void => {
    if (mode !== "system" && mode !== "light" && mode !== "dark") return
    setThemeModePreference(mode as ThemeModePreference)
    const label = mode === "system" ? "跟随系统" : mode === "light" ? "浅色" : "深色"
    toast.success(`外观模式已切换为${label}`)
  }, [])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6 sm:p-8">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-muted/40">
            <Palette className="size-5 text-foreground" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-foreground">外观</h1>
            <p className="mt-1 text-sm text-muted-foreground">设置应用主题和界面视觉效果。</p>
          </div>
        </div>

        <section className="overflow-hidden rounded-xl border border-border/70 bg-muted/20">
          <div className="border-b border-border/60 bg-muted/35 px-5 py-4">
            <h2 className="text-sm font-semibold text-foreground">界面主题</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              使用 CMBDevClaw 经典配色或其他内置主题；选择会在下次启动时保留。
            </p>
          </div>
          <div className="px-5 py-5">
            <div>
              <div className="mb-2 px-0.5">
                <div className="text-[11px] font-medium text-foreground">外观模式</div>
                <p className="mt-0.5 text-[10px] text-muted-foreground">
                  系统模式会根据电脑的浅色或深色设置自动切换。
                </p>
              </div>
              <div role="radiogroup" aria-label="外观模式" className="grid grid-cols-3 gap-3">
                {THEME_MODE_OPTIONS.map((option) => {
                  const selected = themeMode === option.value
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => handleThemeModeChange(option.value)}
                      className="group min-w-0 rounded-lg p-0.5 text-center outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                    >
                      <ThemeModePreview mode={option.value} selected={selected} />
                      <span
                        className={cn(
                          "mt-1.5 block text-xs",
                          selected ? "font-semibold text-foreground" : "text-muted-foreground"
                        )}
                      >
                        {option.label}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="mt-5 space-y-5">
              {THEME_GROUPS.filter(
                (group) => themeMode === "system" || group.colorScheme === themeMode
              ).map((group) => (
                <section key={group.colorScheme}>
                  <div className="mb-2 flex items-center gap-2 px-0.5">
                    <span className="text-[11px] font-medium text-muted-foreground">
                      {group.label}
                    </span>
                    <span className="rounded-full bg-background-interactive px-1.5 py-0.5 text-[9px] tabular-nums text-tertiary-foreground">
                      {group.themes.length}
                    </span>
                    <span className="h-px flex-1 bg-border" />
                  </div>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {group.themes.map((theme) => {
                      const configuredTheme =
                        theme.colorScheme === "dark" ? darkThemePreference : lightThemePreference
                      const selected = configuredTheme === theme.id
                      return (
                        <button
                          key={theme.id}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => handleThemeChange(theme.id)}
                          className={cn(
                            "group relative min-w-0 rounded-xl border p-3 text-left transition-colors",
                            selected
                              ? "border-primary bg-primary/10 ring-1 ring-primary/25"
                              : "border-border bg-background-elevated hover:border-border-emphasis hover:bg-background-interactive"
                          )}
                        >
                          <span className="flex items-center gap-2.5">
                            <span
                              className="flex h-9 w-12 shrink-0 overflow-hidden rounded-lg border shadow-sm"
                              style={{
                                backgroundColor: theme.palette.background,
                                borderColor: theme.palette.border
                              }}
                            >
                              <span
                                className="h-full w-1/2"
                                style={{ backgroundColor: theme.palette.backgroundElevated }}
                              />
                              <span
                                className="m-auto size-2.5 rounded-full"
                                style={{ backgroundColor: theme.palette.primary }}
                              />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                                <span className="truncate">{theme.label}</span>
                                {selected ? (
                                  <Check className="size-3.5 shrink-0 text-primary" />
                                ) : null}
                              </span>
                              <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                                {theme.description}
                              </span>
                            </span>
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </section>

        <section className="overflow-hidden rounded-xl border border-border/70 bg-muted/20">
          <div className="border-b border-border/60 bg-muted/35 px-5 py-4">
            <h2 className="text-sm font-semibold text-foreground">视觉效果</h2>
          </div>
          <div className="flex items-center justify-between gap-4 px-5 py-5">
            <div className="flex min-w-0 items-start gap-3 sm:pr-8">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-background/80 text-muted-foreground shadow-sm ring-1 ring-border/60">
                <Sparkles className="size-4" />
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">输入框动态光效</div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  任务运行时在输入框中显示彩色动态光晕。默认关闭，可按需开启。
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2.5">
              <span className="text-xs text-muted-foreground">
                {appleIntelligenceGlowEnabled ? "已开启" : "已关闭"}
              </span>
              <Switch
                checked={appleIntelligenceGlowEnabled}
                onCheckedChange={handleInputGlowChange}
                aria-label="输入框动态光效"
              />
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
