/** JSON replacer for diagnostic copies of provider requests and graph snapshots. */
export function redactCapturedImage(key: string, value: unknown): unknown {
  if (key === "cmb_chat_images" || key === "chatImages") return undefined
  if (typeof value === "string" && /data:image\//i.test(value)) return "[image]"
  if (value && typeof value === "object" && "type" in value &&
    (value.type === "image_url" || value.type === "input_image" || value.type === "image")) {
    return { type: "text", text: "[image]" }
  }
  return value
}
