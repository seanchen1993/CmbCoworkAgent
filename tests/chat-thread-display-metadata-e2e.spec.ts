/** Build separately; this entry only launches the explicitly selected native candidate. */
import { appendFileSync, writeFileSync } from "node:fs"
import assert from "node:assert/strict"
import { join, resolve } from "node:path"
import type { ElectronApplication, Page } from "playwright"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"
import { runThreadDisplayMetadataCases } from "./support/thread-display-metadata-e2e"

async function main() {
  const root = resolve(__dirname, "..")
  const fixture = projectCompositionEnvironment(root)
  const candidate = projectCompositionCandidate(root)
  if (process.env.METADATA_RACE_EXPECTED_SHA)
    assert.equal(candidate.sha256, process.env.METADATA_RACE_EXPECTED_SHA)
  const events: unknown[] = []
  let app: ElectronApplication | undefined,
    page: Page | undefined,
    passed = false
  const record = (event: unknown): void => {
    events.push(event)
    appendFileSync(join(fixture.isolated, "metadata.ndjson"), JSON.stringify(event) + "\n")
    console.log(JSON.stringify(event))
  }
  try {
    record({ kind: "executed-candidate", ...candidate })
    app = await createHeadlessProjectCompositionLaunch(root, fixture, {
      unobtrusivePresentation: true
    })()
    app
      .process()
      .stdout?.on("data", (data) => appendFileSync(join(fixture.isolated, "main.stdout.log"), data))
    app
      .process()
      .stderr?.on("data", (data) => appendFileSync(join(fixture.isolated, "main.stderr.log"), data))
    page = await app.firstWindow({ timeout: 60_000 })
    await page.waitForFunction(() => !!window.api?.threads)
    await runThreadDisplayMetadataCases(app, page, fixture, record)
    passed = true
  } catch (error) {
    record({ kind: "failure", error: String(error) })
    await page?.screenshot({ path: join(fixture.isolated, "failure.png") }).catch(() => {})
    throw error
  } finally {
    writeFileSync(
      join(fixture.isolated, "acceptance.json"),
      JSON.stringify(
        {
          passed,
          candidate,
          events,
          profile: fixture.isolated,
          acceptanceLane: "native-synthetic-metadata-race",
          realUserHistoryRead: false,
          longHistoryGesturesIncluded: false
        },
        null,
        2
      )
    )
    console.log(JSON.stringify({ passed, profile: fixture.isolated }))
    await app?.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
