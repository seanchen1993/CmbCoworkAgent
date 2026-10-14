import { relative, resolve, sep } from "node:path"

/** Storage ownership convention only; this is never a grant or execution proof. */
export function isCreatorVersionSource(pluginsRoot: string, directory: string): boolean {
  const local = relative(resolve(pluginsRoot), resolve(directory)).split(sep).join("/")
  return /^\.creator-revisions\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/source$/i.test(
    local
  )
}
