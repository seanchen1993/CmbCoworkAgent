import fs from "node:fs"
import path from "node:path"
import { normalizeTemplateSystemKey, type DesignTemplateInfo } from "../../../shared/design-template"
import { DesignTemplatePackages, templateRelativePath } from "./template-packages"
import type { DesignTemplatePreview } from "./template-preview"

interface BundleManifest {
  designSystemKey: string
  templates: Array<{
    name: string
    description: string
    entryPath: string
    skillPath: string
  }>
}

/** A bundle exposes one catalog card per page while sharing its local framework resources. */
export function listBuiltinTemplateBundle(
  directory: string,
  packages: DesignTemplatePackages
): DesignTemplateInfo[] {
  const manifestPath = path.join(directory, "templates.json")
  if (!fs.existsSync(manifestPath)) return []
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BundleManifest
  const designSystemKey = normalizeTemplateSystemKey(manifest.designSystemKey)
  const id = `builtin_${path.basename(directory)}`
  packages.registerBuiltin(id, directory, designSystemKey)
  return manifest.templates.map((entry) => {
    const reference = { id, entryPath: templateRelativePath(entry.entryPath) }
    const template = packages.read(reference)
    const skillPath = templateRelativePath(entry.skillPath)
    if (!template.files.includes(skillPath) || path.posix.basename(skillPath) !== "SKILL.md")
      throw new Error("内置模板缺少技能说明")
    return {
      name: entry.name,
      description: entry.description,
      designSystemKey,
      path: path.join(directory, skillPath),
      mode: "prototype",
      platform: "desktop",
      scenario: "enterprise",
      previewHtml: template.html,
      previewPath: path.join(directory, template.entryPath),
      package: reference
    }
  })
}

export async function prepareBuiltinTemplatePreview(
  item: DesignTemplateInfo,
  packages: DesignTemplatePackages,
  preview: DesignTemplatePreview
): Promise<DesignTemplateInfo> {
  if (!item.package) return item
  const template = packages.read(item.package)
  const previewPath = await preview.url(template)
  const base = `<base href="${new URL(".", previewPath).href}">`
  return {
    ...item,
    previewPath,
    // srcdoc thumbnails need a resource base; the package's source HTML stays unchanged.
    previewHtml: template.html.replace(/<head\b[^>]*>/i, (head) => `${head}${base}`)
  }
}
