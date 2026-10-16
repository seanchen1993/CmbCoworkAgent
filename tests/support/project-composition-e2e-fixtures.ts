import assert from "node:assert/strict"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import AdmZip from "adm-zip"
import { _electron } from "playwright"

export function projectCompositionCandidate(root: string) {
  const directory = process.env.COMPOSITION_E2E_PACKAGED_DIR
  const archive = directory && resolve(root, directory, "resources/app.asar")
  const path = archive || join(root, "out/main/index.js")
  return {
    execution: archive ? "packaged-asar" : "built-output",
    path,
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex")
  }
}

/** No inherited user configuration, credentials, profiles or large package copies. */
export function projectCompositionEnvironment(root: string) {
  // A staged candidate can live deeply inside output/. Keep native SQLite child paths within
  // Windows limits by allowing an explicit, isolated artifact root; never reuse user data.
  const parent = process.env.COMPOSITION_E2E_ARTIFACT_ROOT
    ? resolve(process.env.COMPOSITION_E2E_ARTIFACT_ROOT)
    : resolve(root, "output/project-composition-e2e")
  mkdirSync(parent, { recursive: true })
  const isolated = mkdtempSync(join(parent, "run-"))
  const workspace = join(isolated, "workspace")
  mkdirSync(workspace)
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value &&
      /^(path|systemroot|windir|comspec|pathext|os|processor_architecture|number_of_processors|programfiles.*|lang)$/i.test(
        key
      )
    )
      env[key] = value
  }
  for (const [key, folder] of Object.entries({
    HOME: "home",
    USERPROFILE: "home",
    APPDATA: "appdata",
    LOCALAPPDATA: "localappdata",
    CMB_COWORK_AGENT_HOME: "data",
    TEMP: "temp",
    TMP: "temp"
  })) {
    env[key] = join(isolated, folder)
    mkdirSync(env[key], { recursive: true })
  }
  Object.assign(env, {
    CMB_E2E_DISABLE_GPU: "1",
    ELECTRON_NO_ATTACH_CONSOLE: "1",
    CMB_E2E_ELECTRON_BIN: createRequire(join(root, "package.json"))("electron"),
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "127.0.0.1,localhost"
  })
  return { isolated, workspace, env, artifactRoot: parent }
}

/** Suppress presentation and external login before production imports. Business IPC is unchanged. */
export function createHeadlessProjectCompositionLaunch(
  root: string,
  fixture: ReturnType<typeof projectCompositionEnvironment>,
  options: { offscreen?: boolean; unobtrusivePresentation?: boolean } = {}
) {
  const packageDirectory = process.env.COMPOSITION_E2E_PACKAGED_DIR
  const packaged = packageDirectory ? resolve(root, packageDirectory) : undefined
  if (packageDirectory !== undefined && !packageDirectory.trim()) throw Error("PACKAGE_PATH_EMPTY")
  const archive = packaged && join(packaged, "resources/app.asar")
  const binary = packaged && join(packaged, "CMBDevClaw.exe")
  if (packaged) {
    assert(existsSync(archive!) && existsSync(binary!), "Explicit package must exist; no fallback")
    assert(
      !options.offscreen || process.env.COMPOSITION_E2E_LONG_ONLY === "1",
      "Packaged approval tests require registered native windows; only the chat-only performance fixture may render offscreen"
    )
  }
  const entry = archive ? join(archive, "out/main/index.js") : resolve(root, "out/main/index.js")
  if (archive) {
    const asar = createRequire(join(root, "package.json"))("@electron/asar") as {
      listPackage(path: string): string[]
    }
    const files = asar.listPackage(archive).map((file) => file.replaceAll("\\", "/"))
    assert(files.includes("/out/main/index.js"))
    assert(!files.some((file) => file.endsWith("/mods-e2e.js")))
  } else assert(existsSync(entry), "Build the final candidate before running the real IPC journey")
  assert.equal(dirname(fixture.isolated), fixture.artifactRoot)
  const bootstrap = join(fixture.isolated, "headless-main.cjs")
  writeFileSync(
    bootstrap,
    `
const electron=require('electron');
const {app,BrowserWindow,ipcMain}=electron;
${
  packaged
    ? `// Do not pause product workers on the test launcher's break-on-start flag.
process.execArgv=process.execArgv.filter(arg=>!arg.startsWith('--inspect-brk'));
`
    : ""
}
${
  options.offscreen
    ? `
// Render/performance tests only: Electron omits offscreen windows from its normal
// BrowserWindow registry. Approval journeys must keep the default native window.
class OffscreenWindow extends BrowserWindow {
  constructor(options) {
    super({...options,show:false,webPreferences:{...options?.webPreferences,offscreen:true,backgroundThrottling:false}});
  }
}
const Module=require('node:module');
const load=Module._load;
const headlessElectron={...electron,BrowserWindow:OffscreenWindow};
Module._load=function(id,...args){return id==='electron'?headlessElectron:load.call(this,id,...args)};
`
    : ""
}
${
  options.unobtrusivePresentation
    ? `
// Real native visibility is needed by presentation-gated extensions. Keep the
// test window outside the desktop and never steal the user's keyboard focus.
const showInactive=BrowserWindow.prototype.showInactive;
const present=function(){this.setPosition(-30000,-30000,false);showInactive.call(this)};
BrowserWindow.prototype.show=present;
BrowserWindow.prototype.showInactive=present;
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
`
    : `
BrowserWindow.prototype.show=function(){};
BrowserWindow.prototype.showInactive=function(){};
`
}
BrowserWindow.prototype.focus=function(){};
app.on('web-contents-created',(_event,contents)=>{
  contents.setWindowOpenHandler(()=>({action:'deny'}));
  contents.setBackgroundThrottling(false);
});
${packaged ? "globalThis.__compositionPackagedPresentation = true;" : `require(${JSON.stringify(entry)});`}
app.once('browser-window-created',()=>{ipcMain.removeHandler('open-login-page');ipcMain.handle('open-login-page',()=>undefined)});
`
  )
  return async () => {
    const app = await _electron.launch({
      executablePath: packaged
        ? join(root, "tests/support/project-composition-packaged-launch.cmd")
        : join(root, "tests/support/electron-launcher.cmd"),
      args: packaged
        ? [`--user-data-dir=${join(fixture.isolated, "electron")}`]
        : [bootstrap, `--user-data-dir=${join(fixture.isolated, "electron")}`],
      cwd: root,
      env: packaged
        ? {
            ...fixture.env,
            CMB_COMPOSITION_PRESENTATION: bootstrap,
            CMB_COMPOSITION_BINARY: binary!,
            CMB_COMPOSITION_NODE: process.execPath,
            CMB_COMPOSITION_LAUNCHER: join(
              root,
              "tests/support/project-composition-packaged-launch.mjs"
            )
          }
        : fixture.env,
      timeout: 60000
    })
    if (packaged) {
      try {
        const actual = await app.evaluate(({ app }) => ({
          packaged: app.isPackaged,
          path: app.getAppPath(),
          executable: process.execPath,
          suppressed:
            (globalThis as typeof globalThis & { __compositionPackagedPresentation?: boolean })
              .__compositionPackagedPresentation === true
        }))
        assert.equal(actual.packaged, true)
        assert.equal(
          actual.suppressed,
          true,
          "Presentation suppression must precede product startup"
        )
        assert.equal(realpathSync(actual.path), realpathSync(archive!))
        assert.equal(realpathSync(actual.executable), realpathSync(binary!))
        writeFileSync(
          join(fixture.isolated, "packaged-launch.json"),
          JSON.stringify(
            { ...actual, ...projectCompositionCandidate(root), externalLoginSuppressed: true },
            null,
            2
          )
        )
      } catch (error) {
        await app.close()
        throw error
      }
    }
    return app
  }
}

/** Real traditional adapter establishes a host-owned project index through public createProject IPC. */
export function compositionParentAdapter(nodeExecutable: string): number[] {
  const zip = new AdmZip()
  const add = (path: string, value: unknown) =>
    zip.addFile(path, Buffer.from(typeof value === "string" ? value : JSON.stringify(value)))
  add("plugin.json", {
    name: "composition-parent-fixture",
    version: "1.0.0",
    author: "isolated fixture"
  })
  add(
    "skills/composition-parent/SKILL.md",
    "---\nname: composition-parent\ndescription: Parent project fixture\n---\nOnly inspect the isolated fixture project."
  )
  add(
    "adapter.cjs",
    `const fs=require('node:fs'),path=require('node:path');
const [mode,workspace,project]=process.argv.slice(2);const root=path.join(workspace,project);
if(mode==='createProject'){fs.mkdirSync(root,{recursive:true});console.log('created')}
else if(mode==='project'){console.log(JSON.stringify({workflow:{display:{mode:'ordered_nodes',groupBy:'group'},nodes:[]},projects:{[project]:{runs:[],watchRefs:[]}}}))}
else throw Error('unexpected adapter command');`
  )
  const invoke = `"${nodeExecutable.replaceAll("\\", "/")}" "\${pluginPath}/adapter.cjs"`
  add("board_core/board_config.json", {
    apiVersion: 1,
    inspectCommands: {
      [process.platform]: {
        create_project: `${invoke} createProject "\${pluginWorkspace}" "\${projectDir}"`,
        project_status: `${invoke} project "\${pluginWorkspace}" \${projectDirs...}`
      }
    }
  })
  return [...zip.toBuffer()]
}

/** Distinct installed sources; native scope admission must expose both exact selected skills. */
export function compositionStandaloneSkill(name: string, marker: string): number[] {
  const zip = new AdmZip()
  zip.addFile(
    "plugin.json",
    Buffer.from(JSON.stringify({ name, version: "1.0.0", author: "isolated fixture" }))
  )
  zip.addFile(
    `skills/${name}/SKILL.md`,
    Buffer.from(
      `---\nname: ${name}\ndescription: ${marker}\n---\n${marker}\nAnswer the user's isolated test question.`
    )
  )
  zip.addFile(
    "devclaw.capabilities.json",
    Buffer.from(
      JSON.stringify({
        apiVersion: "devclaw.capabilities/v1",
        capabilities: [
          {
            id: name,
            title: marker,
            kind: "skill",
            usage: "project",
            entry: `skills/${name}/SKILL.md`
          }
        ]
      })
    )
  )
  return [...zip.toBuffer()]
}

export function compositionHostFlow(receivesReport = false): number[] {
  const zip = new AdmZip()
  const add = (name: string, value: unknown) =>
    zip.addFile(name, Buffer.from(typeof value === "string" ? value : JSON.stringify(value)))
  add("plugin.json", {
    name: receivesReport ? "composition-reader-fixture" : "composition-host-fixture",
    version: "1.0.0",
    author: "isolated fixture"
  })
  add(
    "skills/report/SKILL.md",
    receivesReport
      ? "---\nname: composition-reader-report\ndescription: Consume the verified report\n---\nRead incoming/report.md with read_file, then write summary.md with write_file. Preserve the user's goal."
      : "---\nname: composition-host-report\ndescription: Produce the isolated report\n---\nWrite report.md in the current workspace using the original write_file tool. Preserve the user's goal."
  )
  add("devclaw.capabilities.json", {
    apiVersion: "devclaw.capabilities/v1",
    capabilities: [
      {
        id: receivesReport ? "reader-flow" : "report-flow",
        title: receivesReport ? "报告接收流程" : "隔离报告流程",
        kind: "flow",
        usage: "project",
        entry: "devclaw.project-runtime.json",
        ...(receivesReport
          ? {
              inputs: [
                { id: "report", title: "前序报告", path: "incoming/report.md", required: true }
              ]
            }
          : {})
      }
    ]
  })
  add("devclaw.project-runtime.json", {
    apiVersion: "devclaw.project-runtime/v1",
    plugin: {
      id: receivesReport ? "composition-reader-fixture" : "composition-host-fixture",
      version: "1.0.0"
    },
    mode: "host",
    stateOwner: "host",
    stages: [
      {
        id: "report",
        title: receivesReport ? "核对接收报告" : "核对隔离报告",
        actionIds: [],
        artifactIds: ["report"],
        checkIds: ["report-exists"],
        approval: "human",
        skill: "skills/report/SKILL.md"
      }
    ],
    actions: [],
    artifacts: [
      { id: "report", path: receivesReport ? "summary.md" : "report.md", required: true }
    ],
    checks: [
      { id: "report-exists", kind: "file-exists", artifactId: "report", sideEffect: "read" }
    ],
    environment: [],
    capabilities: {
      execution: true,
      conditionalTransition: true,
      idempotency: true,
      reconciliation: false,
      cancellation: true
    }
  })
  return [...zip.toBuffer()]
}
