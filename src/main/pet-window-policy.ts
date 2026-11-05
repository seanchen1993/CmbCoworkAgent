export type PetWindowPlatformPolicy = {
  alwaysOnTopLevel: "floating" | "screen-saver"
  backgroundThrottling: boolean
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
