import { createHash } from "node:crypto"
import type { Plugin } from "vite"

const dependency = "@radix-ui/react-scroll-area"
// Review this transform when upgrading Radix. Only the audited 1.2.12 files qualify.
const upstream: Readonly<Record<string, string>> = {
  mjs: "3b667e0a1704e61a556cf4e3956d97372f92d6c70d700dc09301a95f00e67af1",
  js: "66cd3ddb596617bc5e35325e8634e06b97f34132bd91505da1adf0aee829b749"
}
const original = [
  '    document.addEventListener("wheel", handleWheel, { passive: false });',
  '    return () => document.removeEventListener("wheel", handleWheel, { passive: false });'
].join("\n")
const scoped = [
  "    if (!scrollbar) return;",
  '    scrollbar.addEventListener("wheel", handleWheel, { passive: false });',
  '    return () => scrollbar.removeEventListener("wheel", handleWheel);'
].join("\n")

export function radixScrollbarWheel(): Plugin {
  return {
    name: "cmb-radix-scrollbar-wheel",
    enforce: "pre",
    // Let the renderer transform the original module even on a warm dev server.
    config: () => ({ optimizeDeps: { exclude: [dependency] } }),
    transform(code, id) {
      if (id.startsWith("\0")) return
      const path = id.split("?", 1)[0].replaceAll("\\", "/")
      const match = /\/node_modules\/@radix-ui\/react-scroll-area\/dist\/index\.(mjs|js)$/.exec(path)
      if (!match) return
      const digest = createHash("sha256").update(code).digest("hex")
      const offset = code.indexOf(original)
      if (digest !== upstream[match[1]] || offset < 0 || code.lastIndexOf(original) !== offset)
        this.error(`Expected Radix ScrollArea 1.2.12 for the renderer wheel transform (${path})`)
      // Preserve the original scrollbar-only wheel handler, edge behavior and pointer drag.
      return { code: code.slice(0, offset) + scoped + code.slice(offset + original.length), map: null }
    }
  }
}
