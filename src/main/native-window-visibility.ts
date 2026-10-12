import type { BrowserWindow, IpcMainInvokeEvent } from "electron"
import {
  WINDOW_VISIBILITY_CHANGED,
  type WindowVisibilitySnapshot
} from "../shared/window-visibility"

/** Browser/DevTools focus emulation can leave document.visibilityState visible
 * after the native window hides. The native owner supplies an independent gate. */
export class NativeWindowVisibility {
  private revision = 0
  private visible = false
  private disposed = false
  private sampler?: ReturnType<typeof setInterval>

  constructor(private readonly window: BrowserWindow) {
    this.visible = this.sample()
    window.on("show", this.changed)
    window.on("hide", this.changed)
    window.on("minimize", this.changed)
    window.on("restore", this.changed)
    window.once("closed", this.dispose)
  }

  private sample(): boolean {
    return !this.window.isDestroyed() && this.window.isVisible() && !this.window.isMinimized()
  }

  private changed = (): void => {
    if (this.disposed) return
    const next = this.sample()
    if (next === this.visible) return
    this.visible = next
    this.revision++
    if (!this.window.isDestroyed() && !this.window.webContents.isDestroyed()) {
      try {
        this.window.webContents.mainFrame.send(WINDOW_VISIBILITY_CHANGED, this.snapshot())
      } catch {
        // A reload may destroy the frame between the checks and delivery.
        // The replacement renderer reads the current snapshot on subscription.
      }
    }
  }

  private snapshot(): WindowVisibilitySnapshot {
    return { revision: this.revision, visible: this.visible }
  }

  /** App-owned show/hide calls can publish immediately even if the OS omits an event. */
  refresh(): void {
    this.changed()
  }

  read(event: IpcMainInvokeEvent): WindowVisibilitySnapshot {
    if (
      this.disposed ||
      this.window.isDestroyed() ||
      this.window.webContents.isDestroyed() ||
      event.sender.id !== this.window.webContents.id ||
      event.senderFrame !== this.window.webContents.mainFrame
    )
      throw new Error("Window visibility is only available to the main window")
    // Electron 39 on macOS can omit show/hide events (reproduced with a bare
    // BrowserWindow). Start one native-only fallback when a viewer first reads;
    // no screenshots, file reads or IPC traffic while the state stays unchanged.
    if (!this.sampler) {
      this.sampler = setInterval(this.changed, 1000)
      this.sampler.unref()
    }
    this.changed()
    return this.snapshot()
  }

  private dispose = (): void => {
    if (this.disposed) return
    this.disposed = true
    clearInterval(this.sampler)
    this.sampler = undefined
    this.window.removeListener("show", this.changed)
    this.window.removeListener("hide", this.changed)
    this.window.removeListener("minimize", this.changed)
    this.window.removeListener("restore", this.changed)
    this.window.removeListener("closed", this.dispose)
  }
}
