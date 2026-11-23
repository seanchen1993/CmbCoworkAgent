// Adapted from Hermes Agent (Nous Research), MIT. See LICENSE.hermes.
export const RENDERER_ANIMATIONS_PAUSED_ATTRIBUTE = "data-renderer-animations-paused"

export function createRendererLoopPauseController(
  onChange: () => void,
  { pauseWhenUnfocused = false } = {}
) {
  let windowFocused = document.hasFocus()

  const onVisibilityChange = () => onChange()

  const onBlur = () => {
    if (windowFocused) {
      windowFocused = false
      onChange()
    }
  }

  const onFocus = () => {
    if (!windowFocused) {
      windowFocused = true
      onChange()
    }
  }

  document.addEventListener("visibilitychange", onVisibilityChange)

  if (pauseWhenUnfocused) {
    window.addEventListener("blur", onBlur)
    window.addEventListener("focus", onFocus)
  }

  return {
    dispose: () => {
      document.removeEventListener("visibilitychange", onVisibilityChange)
      window.removeEventListener("blur", onBlur)
      window.removeEventListener("focus", onFocus)
    },
    isPaused: () => document.visibilityState === "hidden" || (pauseWhenUnfocused && !windowFocused)
  }
}

/**
 * Mirrors the main window's observability onto :root so continuous decorative
 * CSS animations can sleep with the JS renderer loops. The caller owns the
 * returned cleanup; overlay windows intentionally do not install this state.
 */
export function installRendererAnimationPauseState(): () => void {
  const root = document.documentElement
  let controller: ReturnType<typeof createRendererLoopPauseController>

  const sync = () =>
    root.toggleAttribute(RENDERER_ANIMATIONS_PAUSED_ATTRIBUTE, controller.isPaused())

  controller = createRendererLoopPauseController(sync)
  sync()

  return () => {
    controller.dispose()
    root.removeAttribute(RENDERER_ANIMATIONS_PAUSED_ATTRIBUTE)
  }
}
