import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import AdmZip from "adm-zip"
import { afterEach, describe, expect, it } from "vitest"
import { DesignPackageService, resolveDesignArtifactLayout } from "./design-package"
import { writeZipFromDirectoryStreaming } from "./streaming-zip"

const tempDirs: string[] = []
function makeTempDir(prefix = "cmb-design-pkg-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

describe("DesignPackageService & lifecycle", () => {
  it("stages single HTML with transitive local deps and reports missing/out-of-scope assets", async () => {
    const root = makeTempDir()
    const siteDir = path.join(root, "site")
    const workspace = path.join(root, "ws")
    fs.mkdirSync(path.join(siteDir, "css"), { recursive: true })
    fs.mkdirSync(path.join(siteDir, "images"), { recursive: true })
    fs.mkdirSync(path.join(siteDir, "fonts"), { recursive: true })
    fs.mkdirSync(path.join(siteDir, "js"), { recursive: true })
    fs.mkdirSync(workspace, { recursive: true })

    fs.writeFileSync(
      path.join(siteDir, "css/main.css"),
      `@import "./tokens.css"; .hero { background: url('../images/hero.webp'); } @font-face { src: url('../fonts/main.woff2'); }`,
      "utf8"
    )
    fs.writeFileSync(path.join(siteDir, "css/tokens.css"), ":root { --c: #111; }", "utf8")
    fs.writeFileSync(path.join(siteDir, "images/hero.webp"), Buffer.from("webp-1"))
    fs.writeFileSync(path.join(siteDir, "images/hero-2x.webp"), Buffer.from("webp-2"))
    fs.writeFileSync(path.join(siteDir, "fonts/main.woff2"), Buffer.from("woff2"))
    fs.writeFileSync(path.join(siteDir, "js/app.js"), "console.log('ok')", "utf8")

    const htmlPath = path.join(siteDir, "index.html")
    fs.writeFileSync(
      htmlPath,
      `<!DOCTYPE html>
      <html>
        <head><link rel="stylesheet" href="./css/main.css"></head>
        <body>
          <img src="./images/hero.webp" srcset="./images/hero.webp 1x, ./images/hero-2x.webp 2x">
          <img src="./images/missing.png">
          <img src="../outside.png">
          <link rel="stylesheet" href="/root-style.css">
          <script type="module" src="./js/app.js"></script>
        </body>
      </html>`,
      "utf8"
    )

    const svc = new DesignPackageService()
    const staged = await svc.stageImport(1, htmlPath, workspace)
    expect(staged.sourceKind).toBe("html")
    expect(staged.defaultEntryPath).toBe("index.html")
    expect(staged.missingAssets).toContain("images/missing.png")
    expect(staged.outOfScopeAssets).toEqual(expect.arrayContaining(["../outside.png", "/root-style.css"]))

    const committed = await svc.commitStage(1, {
      stageId: staged.stageId!,
      entryPath: "index.html",
      sessionId: "ds_single",
      workspacePath: workspace
    })
    expect(fs.existsSync(path.join(committed.packageRoot, "images/hero.webp"))).toBe(true)
    expect(fs.existsSync(path.join(committed.packageRoot, "images/hero-2x.webp"))).toBe(true)
    expect(fs.existsSync(path.join(committed.packageRoot, "fonts/main.woff2"))).toBe(true)
    expect(fs.existsSync(path.join(committed.packageRoot, "css/tokens.css"))).toBe(true)
    expect(fs.existsSync(path.join(committed.packageRoot, "js/app.js"))).toBe(true)
    expect(committed.html).toContain("./images/hero.webp")
    expect(committed.html).not.toContain("data:image/")
  })

  it("imports multi-entry ZIP with nested entry, >=8MB asset, keeps HTML size unchanged, and GCs replaced packages after release", async () => {
    const root = makeTempDir()
    const buildDir = path.join(root, "raw-site")
    const workspace = path.join(root, "workspace")
    const workspaceNext = path.join(root, "workspace-next")
    fs.mkdirSync(path.join(buildDir, "pages"), { recursive: true })
    fs.mkdirSync(path.join(buildDir, "images"), { recursive: true })
    fs.mkdirSync(path.join(buildDir, "fonts"), { recursive: true })
    fs.mkdirSync(path.join(buildDir, "data"), { recursive: true })
    fs.mkdirSync(workspace, { recursive: true })
    fs.mkdirSync(workspaceNext, { recursive: true })

    const entryHtml = `<!DOCTYPE html>
    <html>
      <head>
        <style>
          @font-face { font-family: 'MainFont'; src: url('../fonts/main.woff2'); }
          .bg { background-image: url('../images/海报.png'); }
        </style>
      </head>
      <body>
        <img src="../images/hero.webp" srcset="../images/hero.webp 1x">
        <svg><use href="../images/icons.svg#logo"></use></svg>
        <script type="module">fetch('../data/config.json');</script>
      </body>
    </html>`

    fs.writeFileSync(path.join(buildDir, "pages/home.html"), entryHtml, "utf8")
    fs.writeFileSync(path.join(buildDir, "other.html"), "<html><body>other</body></html>", "utf8")
    fs.writeFileSync(path.join(buildDir, "fonts/main.woff2"), Buffer.from("woff2-bytes"))
    fs.writeFileSync(path.join(buildDir, "images/海报.png"), Buffer.from("cn-png"))
    fs.writeFileSync(path.join(buildDir, "images/icons.svg"), "<svg id='logo'></svg>", "utf8")
    fs.writeFileSync(path.join(buildDir, "data/config.json"), '{"ok":true}', "utf8")
    fs.writeFileSync(path.join(buildDir, "images/hero.webp"), Buffer.alloc(1024 * 1024, 1))

    const zip1 = path.join(root, "site-1mb.zip")
    await writeZipFromDirectoryStreaming(buildDir, zip1)

    fs.writeFileSync(path.join(buildDir, "images/hero.webp"), Buffer.alloc(8 * 1024 * 1024, 2))
    const zip8 = path.join(root, "site-8mb.zip")
    await writeZipFromDirectoryStreaming(buildDir, zip8)

    let inUseRoot: string | null = null
    let exportLockedRoot: string | null = null
    const svc = new DesignPackageService({
      isPackageInUse: (dir) =>
        (inUseRoot !== null && path.resolve(dir).startsWith(inUseRoot)) ||
        (exportLockedRoot !== null && path.resolve(dir).startsWith(exportLockedRoot)),
      isExportInUse: (dir) => exportLockedRoot !== null && path.resolve(dir).startsWith(path.resolve(exportLockedRoot))
    })

    const stage1 = await svc.stageImport(1, zip1, workspace)
    expect(stage1.pages).toEqual(expect.arrayContaining(["pages/home.html", "other.html"]))
    const commit1 = await svc.commitStage(1, {
      stageId: stage1.stageId,
      entryPath: "pages/home.html",
      sessionId: "ds_pkg1",
      workspacePath: workspace
    })

    // Remove original archive and verify package survives on disk.
    fs.rmSync(zip1, { force: true })
    expect(fs.existsSync(commit1.entryFilePath)).toBe(true)
    const metaFile = path.join(path.dirname(path.dirname(path.dirname(commit1.packageRoot))), "artifact.json")
    fs.writeFileSync(
      metaFile,
      JSON.stringify({ artifactPackage: commit1.packageRef, htmlPath: commit1.entryFilePath }, null, 2)
    )

    const resolvedLayout = resolveDesignArtifactLayout({
      sessionId: "ds_pkg1",
      workspacePath: workspace,
      fallbackRootDir: workspace
    })
    expect(resolvedLayout.isPackage).toBe(true)
    expect(resolvedLayout.entryRelativePath).toBe("pages/home.html")

    // Hold lock on v1, replace with 8MB package, verify v1 stays until released, and HTML length is unchanged.
    inUseRoot = path.resolve(commit1.packageRoot)
    const stage8 = await svc.stageImport(1, zip8, workspace)
    const commit8 = await svc.commitStage(1, {
      stageId: stage8.stageId,
      entryPath: "pages/home.html",
      sessionId: "ds_pkg1",
      workspacePath: workspace
    })
    expect(Buffer.byteLength(commit8.html, "utf8")).toBe(Buffer.byteLength(commit1.html, "utf8"))
    expect(fs.statSync(path.join(commit8.packageRoot, "images/hero.webp")).size).toBe(8 * 1024 * 1024)

    svc.retirePackageRoot(commit1.packageRoot)
    expect(fs.existsSync(commit1.packageRoot)).toBe(true)
    inUseRoot = null
    await svc.tryCleanupRetired(commit1.packageRoot)
    expect(fs.existsSync(path.dirname(commit1.packageRoot))).toBe(false)

    // Corrupt zip import must leave commit8 intact.
    const corruptZip = path.join(root, "corrupt.zip")
    fs.writeFileSync(corruptZip, "NOT_A_ZIP")
    await expect(svc.stageImport(1, corruptZip, workspace)).rejects.toThrow()
    expect(fs.existsSync(commit8.entryFilePath)).toBe(true)

    // Write v2 metadata & test workspace migration.
    fs.writeFileSync(
      metaFile,
      JSON.stringify({ artifactPackage: commit8.packageRef, htmlPath: commit8.entryFilePath }, null, 2)
    )
    exportLockedRoot = path.dirname(path.dirname(path.dirname(commit8.packageRoot)))
    await expect(
      svc.migrateSessionArtifacts({
        sessionId: "ds_pkg1",
        oldWorkspacePath: workspace,
        newWorkspacePath: workspaceNext,
        artifactPackage: commit8.packageRef,
        artifactPath: commit8.entryFilePath
      })
    ).rejects.toThrow(/正在导出/)

    exportLockedRoot = null
    inUseRoot = path.resolve(commit8.packageRoot) // active preview should NOT block workspace switch
    const migrated = await svc.migrateSessionArtifacts({
      sessionId: "ds_pkg1",
      oldWorkspacePath: workspace,
      newWorkspacePath: workspaceNext,
      artifactPackage: commit8.packageRef,
      artifactPath: commit8.entryFilePath
    })
    expect(() => svc.assertSessionAvailable("ds_pkg1")).toThrow(/迁移/)
    expect(() => svc.lockSession("ds_pkg1", "import")).toThrow(/迁移/)
    await migrated.commitCleanup()
    expect(() => svc.assertSessionAvailable("ds_pkg1")).not.toThrow()
    expect(migrated.newArtifactPath).toBeTruthy()
    expect(fs.existsSync(migrated.newArtifactPath!)).toBe(true)
    const migratedMeta = JSON.parse(
      fs.readFileSync(path.join(workspaceNext, ".cmb-design/ds_pkg1_design-main/artifact.json"), "utf8")
    )
    expect(migratedMeta.htmlPath).toBe(migrated.newArtifactPath)
  })

  it.each([false, true])("rebases mixed workspace aliases without removing files (package: %s)", async (packaged) => {
    const workspace = makeTempDir()
    const alias = path.join(makeTempDir(), "workspace-alias")
    fs.symlinkSync(workspace, alias, "junction")
    const oldAlias = path.join(makeTempDir(), "old-alias")
    fs.symlinkSync(workspace, oldAlias, "junction")
    const artifactPackage = packaged
      ? { version: "pkg_alias", entryPath: "pages/index.html", sourceKind: "zip" as const, assetCount: 0 }
      : null
    const relative = path.join(".cmb-design", "ds_alias_design-main", artifactPackage
      ? path.join("packages", artifactPackage.version, "files", artifactPackage.entryPath)
      : "index.html")
    const source = path.join(workspace, relative)
    fs.mkdirSync(path.dirname(source), { recursive: true })
    fs.writeFileSync(source, "<h1>Alias</h1>")
    const service = new DesignPackageService()
    const migration = await service.migrateSessionArtifacts({
      sessionId: "ds_alias", oldWorkspacePath: oldAlias, newWorkspacePath: alias, artifactPath: source, artifactPackage
    })
    expect(migration.newArtifactPath).toBe(path.join(alias, relative))
    await migration.commitCleanup()
    expect(fs.readFileSync(source, "utf8")).toBe("<h1>Alias</h1>")
  })

  it("saves Pixso prototype screenshots as independent image files instead of Base64", async () => {
    const root = makeTempDir()
    const workspace = path.join(root, "ws")
    fs.mkdirSync(workspace, { recursive: true })
    const pixsoZip = path.join(root, "proto.zip")

    // Minimal valid 1x1 PNG header + body
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    )
    const zip = new AdmZip()
    zip.addFile("frames/Home.png", pngBytes)
    zip.addFile(
      "meta.json",
      Buffer.from(JSON.stringify([{ id: "home", name: "首页", image: "frames/Home.png", width: 390, height: 844 }]))
    )
    zip.writeZip(pixsoZip)

    const svc = new DesignPackageService()
    const result = await svc.stageAndBuildPixsoPackage(pixsoZip, "ds_pixso", workspace)
    expect(result.imageCount).toBe(1)
    expect(result.html).not.toContain("data:image/")
    expect(result.html).toContain("./screens/screen-001.png")
    expect(fs.existsSync(path.join(result.packageRoot, "screens/screen-001.png"))).toBe(true)
  })
})
