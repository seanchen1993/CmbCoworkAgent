import assert from "node:assert/strict"
import { app } from "electron"
import { join } from "node:path"
import { compileFunctionPlugin } from "../../src/main/mods/v2/loader"
import { bundledModExamplesRoot } from "../../src/main/mods/bundled-examples"

const output = process.argv[2]
app.setPath("userData", join(output, "profile"))
app.commandLine.appendSwitch("disable-gpu")
void app
  .whenReady()
  .then(async () => {
    const virtual = join(output, "packed-control.asar/out/resources/mods/function-commands")
    // Reproduce the actual installed app failure: virtual and opened file identities differ.
    await assert.rejects(compileFunctionPlugin(virtual), /File changed|trusted root|ENOENT/)
    const real = join(
      bundledModExamplesRoot(join(output, "app.asar/out/main")),
      "function-commands"
    )
    const compiled = await compileFunctionPlugin(real)
    assert.equal(compiled.name, "function-commands")
    assert(compiled.sources.length > 8)
    assert(Object.keys(compiled.clients).length > 0)
    console.log(
      "PASS actual Electron ASAR identity failure and unpacked Function plugin compilation"
    )
    app.exit(0)
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
