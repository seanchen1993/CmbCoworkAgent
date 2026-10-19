/** Build the optional sample from normal source, never overwrite existing delivery files. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import AdmZip from "adm-zip"
import { compileFunctionPlugin } from "../src/main/mods/v2/loader"
import { checkFunctionPlugin } from "../src/main/mods/devtools/check"
import { checkFunctionAuthorTypes } from "../src/main/mods/devtools/authoring-check"

async function main() {
  const root = resolve(__dirname, "..")
  const source = join(root, "examples/mods-creator-planning")
  const target = join(root, "output/deliveries/creator-planning-mod-20261017")
  const compiled = await compileFunctionPlugin(source, { captureSources: true })
  const check = await checkFunctionPlugin(source)
  const types = await checkFunctionAuthorTypes(source)
  assert.equal(check.valid, true)
  assert.equal(types.valid, true, JSON.stringify(types.diagnostics))
  assert.equal(check.digest, compiled.digest)
  assert.equal(types.digest, compiled.digest)
  const zip = new AdmZip()
  for (const name of ["plugin.json", "mods/manifest.json", "mods/main.ts", "README.md"])
    zip.addFile(name, await readFile(join(source, name)))
  await mkdir(target, { recursive: true })
  const archive = join(target, "creator-review-first-1.0.0.zip")
  const buffer = zip.toBuffer()
  await writeFile(archive, buffer, { flag: "wx" })
  await assert.rejects(writeFile(archive, buffer, { flag: "wx" }), { code: "EEXIST" })
  const evidence = {
    source,
    digest: compiled.digest,
    check,
    types,
    archive,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    noOverwriteVerified: true
  }
  await writeFile(join(target, "verification.json"), JSON.stringify(evidence, null, 2), {
    flag: "wx"
  })
  await writeFile(
    join(target, "安装说明.txt"),
    "适用于支持创造者可选规划策略的本次新版本。\n1. 添加功能 → 从本地导入 creator-review-first-1.0.0.zip，启用并按原生界面核对授权。\n2. 打开工作区会话并进入创造者模式。\n3. 创作选项 → 可选规划策略，选择 creator-review-first，点击验证并使用。\n4. 可替换为其他提供 creator.planning 的 Function Mod，或撤回恢复原生。\n该策略只追加规划建议，不增加工具或权限；停用、损坏或卸载自动回退原生。\n原生停止、核对安装和恢复功能保持可用。\n",
    { flag: "wx" }
  )
  console.log(
    JSON.stringify({ archive, sha256: evidence.sha256, valid: true, noOverwriteVerified: true })
  )
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
