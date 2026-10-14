/** Electron 39 writes are synchronous but may fail without throwing (for example a busy clipboard). */
export function writeFunctionClipboard(
  clipboard: { writeText(text: string): void; readText(): string },
  text: string
): void {
  // Electron 39 cannot distinguish an empty successful read from a denied read.
  // Format availability also does not require opening the clipboard on Windows.
  if (text === "") throw Error("MODS_DESKTOP_CLIPBOARD_WRITE_UNCONFIRMED")
  clipboard.writeText(text)
  // Compare only with the protected text just written. Never return existing clipboard data.
  if (clipboard.readText() !== text) throw Error("MODS_DESKTOP_CLIPBOARD_WRITE_UNCONFIRMED")
}
