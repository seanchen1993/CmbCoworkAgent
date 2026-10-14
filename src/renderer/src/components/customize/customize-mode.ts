export type CustomizePresentationMode = "ordinary" | "creator"
export const CREATOR_TABS = new Set(["mods", "flows", "claw", "evaluation"])
const KEY = "cmbdevclaw.customize.presentation-mode.v1"
/** A local navigation preference only; never a permission or runtime setting. */
export function readCustomizePresentationMode(): CustomizePresentationMode {
  try {
    return localStorage.getItem(KEY) === "creator" ? "creator" : "ordinary"
  } catch {
    return "ordinary"
  }
}
export function saveCustomizePresentationMode(mode: CustomizePresentationMode): void {
  try {
    localStorage.setItem(KEY, mode)
  } catch {
    /* Unavailable storage keeps this window's state. */
  }
}
