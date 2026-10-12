import { randomFillSync } from "node:crypto"
import { createCanvas } from "@napi-rs/canvas"

export async function avatarImage(color = "#1084fe", edge = 256): Promise<string> {
  const canvas = createCanvas(edge, edge)
  const context = canvas.getContext("2d")
  context.fillStyle = color
  context.fillRect(0, 0, edge, edge)
  return (await canvas.encode("png")).toString("base64")
}

export async function noisyImage(): Promise<Buffer> {
  const canvas = createCanvas(3000, 2000),
    context = canvas.getContext("2d")
  const pixels = context.createImageData(canvas.width, canvas.height)
  randomFillSync(pixels.data)
  for (let index = 3; index < pixels.data.length; index += 4) pixels.data[index] = 255
  context.putImageData(pixels, 0, 0)
  return canvas.encode("png")
}
