export type PetWindowLayoutMetrics = {
  petLeft: number
  petTop: number
}

export type PetWindowBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type PetWindowPlatformPolicy = {
  alwaysOnTopLevel: "floating" | "screen-saver"
  backgroundThrottling: boolean
  compactWhenBubbleHidden: boolean
  forwardIgnoredMouseMoves: boolean
  hoverPollIntervalMs: number
  idleFpsCap: number | null
  raiseOnBubbleShow: boolean
  visibleOnAllWorkspaces: boolean
}

export type PetSettingsSnapshot = {
  enabled: boolean
  selectedPetKey: string | null
}

export type PetWindowRefreshAction = "none" | "close" | "create" | "recreate"

export function getPetWindowPlatformPolicy(platform: NodeJS.Platform): PetWindowPlatformPolicy {
  if (platform === "win32") {
    return {
      alwaysOnTopLevel: "floating",
      backgroundThrottling: true,
      compactWhenBubbleHidden: false,
      forwardIgnoredMouseMoves: false,
      hoverPollIntervalMs: 100,
      idleFpsCap: 2,
      raiseOnBubbleShow: false,
      visibleOnAllWorkspaces: false
    }
  }

  return {
    alwaysOnTopLevel: "screen-saver",
    backgroundThrottling: false,
    compactWhenBubbleHidden: false,
    forwardIgnoredMouseMoves: true,
    hoverPollIntervalMs: 250,
    idleFpsCap: null,
    raiseOnBubbleShow: true,
    visibleOnAllWorkspaces: true
  }
}

export function shouldIgnorePetWindowMouseEvents(options: {
  dragging: boolean
  hoveringPet: boolean
  hoveringBubble: boolean
}): boolean {
  return !options.dragging && !options.hoveringPet && !options.hoveringBubble
}

export function getPetWindowRefreshAction(
  previous: PetSettingsSnapshot,
  next: PetSettingsSnapshot
): PetWindowRefreshAction {
  if (previous.enabled === next.enabled && previous.selectedPetKey === next.selectedPetKey) {
    return "none"
  }
  if (!next.enabled) return previous.enabled ? "close" : "none"
  if (!previous.enabled) return "create"
  return previous.selectedPetKey === next.selectedPetKey ? "none" : "recreate"
}

export function resizeWindowAroundPetBody(
  currentBounds: PetWindowBounds,
  currentLayout: PetWindowLayoutMetrics,
  nextLayout: PetWindowLayoutMetrics,
  nextSize: Pick<PetWindowBounds, "width" | "height">
): PetWindowBounds {
  const petX = currentBounds.x + currentLayout.petLeft
  const petY = currentBounds.y + currentLayout.petTop

  return {
    x: petX - nextLayout.petLeft,
    y: petY - nextLayout.petTop,
    width: nextSize.width,
    height: nextSize.height
  }
}
