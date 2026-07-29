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
  idleFpsCap: number | null
  useWindowShapeForHitTesting: boolean
  visibleOnAllWorkspaces: boolean
}

export function getPetWindowPlatformPolicy(platform: NodeJS.Platform): PetWindowPlatformPolicy {
  if (platform === "win32") {
    return {
      alwaysOnTopLevel: "floating",
      backgroundThrottling: true,
      compactWhenBubbleHidden: false,
      forwardIgnoredMouseMoves: false,
      idleFpsCap: 2,
      useWindowShapeForHitTesting: true,
      visibleOnAllWorkspaces: false
    }
  }

  return {
    alwaysOnTopLevel: "screen-saver",
    backgroundThrottling: false,
    compactWhenBubbleHidden: false,
    forwardIgnoredMouseMoves: true,
    idleFpsCap: null,
    useWindowShapeForHitTesting: false,
    visibleOnAllWorkspaces: true
  }
}

export function getPetWindowShapeRects(
  petRect: PetWindowBounds,
  bubbleRect: PetWindowBounds,
  bubbleVisible: boolean
): PetWindowBounds[] {
  return bubbleVisible ? [petRect, bubbleRect] : [petRect]
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
