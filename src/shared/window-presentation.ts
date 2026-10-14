export const WINDOW_PRESENTATION_READ = "window-presentation:read"
export const WINDOW_PRESENTATION_CHANGED = "window-presentation:changed"

export interface WindowPresentationSnapshot {
  version: number
  presentable: boolean
}
export interface WindowPresentationBridge {
  read(): Promise<WindowPresentationSnapshot>
  onChanged(callback: (snapshot: WindowPresentationSnapshot) => void): () => void
}
