import { dialog, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from "electron"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { open, rename, rm } from "node:fs/promises"
import {
  isGeneratedImageId,
  type GeneratedImageLookup,
  type GeneratedImageSource,
  type GeneratedImageVariant
} from "../../shared/generated-image"
import { assertChatAttachmentWindow } from "./chat-attachment-window"

function validKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1024
}

function validSource(source: GeneratedImageSource) {
  if (
    !source ||
    typeof source !== "object" ||
    !isGeneratedImageId(source.actionId) ||
    !validKey(source.messageId)
  )
    return false
  if ("groupId" in source)
    return (
      !("threadId" in source) &&
      validKey(source.groupId) &&
      Number.isSafeInteger(source.fileIndex) &&
      source.fileIndex >= 0
    )
  return validKey(source.threadId)
}

export function registerGeneratedImageHandlers(
  ipcMain: IpcMain,
  getMainWindow: () => BrowserWindow | null
) {
  const assertSender = (event: IpcMainInvokeEvent) =>
    assertChatAttachmentWindow(event, getMainWindow)
  async function read(
    event: IpcMainInvokeEvent,
    source: GeneratedImageSource,
    variant: GeneratedImageVariant
  ) {
    const check = () => assertSender(event)
    check()
    if (!validSource(source) || (variant !== "thumbnail" && variant !== "original"))
      throw new Error("生成图片引用无效")
    if ("groupId" in source) {
      const { readDeliveredGeneratedImage } = await import("../bots/generated-image-delivery")
      return readDeliveredGeneratedImage(source, variant, check)
    }
    const { readGeneratedImage } = await import("../generated-images")
    return readGeneratedImage(source, variant, check)
  }
  ipcMain.handle("generated-images:availability", async (event) => {
    assertSender(event)
    const { imageGenerationAvailability } = await import("../models/image-generation")
    assertSender(event)
    return imageGenerationAvailability()
  })
  ipcMain.handle("generated-images:lookup", async (event, source: GeneratedImageLookup) => {
    assertSender(event)
    if (
      !source ||
      !validKey(source.threadId) ||
      !validKey(source.messageId) ||
      !validKey(source.callId)
    )
      throw new Error("生成图片引用无效")
    const { lookupGeneratedImage } = await import("../generated-images")
    return lookupGeneratedImage(source, () => assertSender(event))
  })
  ipcMain.handle(
    "generated-images:read",
    async (event, source: GeneratedImageSource, variant: GeneratedImageVariant) => {
      const image = await read(event, source, variant)
      return "data:" + image.mimeType + ";base64," + image.bytes.toString("base64")
    }
  )
  ipcMain.handle("generated-images:save", async (event, source: GeneratedImageSource) => {
    const window = assertSender(event)
    if (!validSource(source)) throw new Error("生成图片引用无效")
    const image = await read(event, source, "original")
    const target = await dialog.showSaveDialog(window, {
      title: "保存生成的图片",
      defaultPath: "generated-" + source.actionId + ".png",
      filters: [{ name: "PNG 图片", extensions: ["png"] }]
    })
    if (target.canceled || !target.filePath) return false
    image.assertCurrent()
    const temp = join(dirname(target.filePath), randomUUID() + ".tmp")
    const file = await open(temp, "wx", 0o600)
    try {
      try {
        await file.writeFile(image.bytes)
      } finally {
        await file.close()
      }
      // The user may have closed the view or withdrawn the group delivery during the disk write.
      image.assertCurrent()
      await rename(temp, target.filePath)
    } finally {
      await rm(temp, { force: true })
    }
    return true
  })
}
