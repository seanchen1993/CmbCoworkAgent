import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { verifyPackagedArtifactIntegrity } from "../src/main/build/packaged-artifact-integrity"

async function main(): Promise<void> {
  const [directory, expected, report] = process.argv.slice(2)
  if (!directory || !expected || !report)
    throw Error("Usage: verify-packaged-artifact <downloaded> <original> <report.json>")
  const result = await verifyPackagedArtifactIntegrity(directory, expected)
  const output = resolve(report)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(result, null, 2) + "\n", "utf8")
  console.log(JSON.stringify(result))
  if (!result.passed) process.exitCode = 1
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "PACKAGED_ARTIFACT_INVALID")
  process.exitCode = 1
})
