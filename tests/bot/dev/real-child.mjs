import { parseArgs, configFromOptions } from "../../../deploy/dev/config.mjs"
import { realProbe } from "../../../deploy/dev/mysql-probe.mjs"

// A dedicated finite test child for an actual OS SIGTERM, not another service.
const controller = new AbortController()
const cancel = () => controller.abort()
process.once("SIGTERM", cancel)
process.once("SIGINT", cancel)
const deadline = setTimeout(cancel, 45000)
try {
  const { options } = parseArgs(process.argv.slice(2))
  const result = await realProbe(await configFromOptions(options), options, {
    signal: controller.signal,
    onResource: (resource) => console.log(JSON.stringify({ resource }))
  })
  console.log(JSON.stringify({ result }))
} catch (error) {
  console.log(JSON.stringify({ failure: error.diagnostic ?? { reason: "test_child_failed" } }))
  process.exitCode = controller.signal.aborted ? 0 : 1
} finally {
  clearTimeout(deadline)
  process.removeListener("SIGTERM", cancel)
  process.removeListener("SIGINT", cancel)
}
