/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs")
const path = require("path")

module.exports = async function (context) {
  if (context?.electronPlatformName === "darwin") {
    const { Arch } = require("electron-builder")
    const arch = Arch[context.arch]
    const productName = context.packager.appInfo.productFilename
    const resources = path.join(context.appOutDir, `${productName}.app`, "Contents", "Resources")
    const ptyRoot = path.join(resources, "app.asar.unpacked", "node_modules", "node-pty")
    // Match node-pty's native module lookup order. The helper must be next to
    // the module actually loaded, rather than merely existing elsewhere.
    const nativeDirectories = [
      path.join(ptyRoot, "build", "Release"),
      path.join(ptyRoot, "build", "Debug"),
      path.join(ptyRoot, "prebuilds", `darwin-${arch}`)
    ]
    const selected = nativeDirectories.find((directory) =>
      fs.existsSync(path.join(directory, "pty.node"))
    )
    if (!selected || !fs.existsSync(path.join(selected, "spawn-helper"))) {
      throw new Error(
        `after-pack: macOS spawn-helper missing beside active pty.node in ${ptyRoot} (${arch})`
      )
    }
    // The npm prebuild's helper is not executable. Repair before signing;
    // changing the bundle after signing would invalidate the signature.
    for (const directory of nativeDirectories) {
      const helper = path.join(directory, "spawn-helper")
      if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755)
    }
    fs.chmodSync(path.join(resources, "bin", "darwin", "rg"), 0o755)
    return
  }

  try {
    const isLinux =
      (context?.electronPlatformName || process.platform) === "linux" ||
      process.env.FORCE_AFTER_PACK_LINUX === "1"
    if (!isLinux) {
      console.log(
        `after-pack: not running because platform is ${process.platform} (only runs on 'linux')`
      )
      return
    }

    const appOutDir = context && context.appOutDir ? context.appOutDir : process.env.APP_OUT_DIR
    if (!appOutDir) {
      console.log("after-pack: no appOutDir provided, skipping")
      return
    }

    const productName =
      (context &&
        context.packager &&
        context.packager.appInfo &&
        context.packager.appInfo.productFilename) ||
      "CMBDevClaw"
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../package.json"), "utf-8")
    )
    const packageName = packageJson.name
    const launcherPath = path.join(appOutDir, productName)
    const packageBinPath = path.join(appOutDir, packageName)
    const legacyBinPath = path.join(appOutDir, `${productName}.bin`)
    const isElfBinary = (filePath) => {
      try {
        const fd = fs.openSync(filePath, "r")
        try {
          const magic = Buffer.alloc(4)
          const bytesRead = fs.readSync(fd, magic, 0, 4, 0)
          return (
            bytesRead === 4 &&
            magic[0] === 0x7f &&
            magic[1] === 0x45 &&
            magic[2] === 0x4c &&
            magic[3] === 0x46
          )
        } finally {
          fs.closeSync(fd)
        }
      } catch {
        return false
      }
    }

    // 1. 删除 chrome-sandbox，避免 SUID 权限报错
    const sandboxPath = path.join(appOutDir, "chrome-sandbox")
    if (fs.existsSync(sandboxPath)) {
      fs.rmSync(sandboxPath)
      console.log("after-pack: removed chrome-sandbox from", sandboxPath)
    }

    // 2. 确保真正的二进制是 package.json name（cmbdevclaw），让进程名和更新脚本一致
    if (!fs.existsSync(packageBinPath)) {
      if (fs.existsSync(legacyBinPath) && isElfBinary(legacyBinPath)) {
        fs.renameSync(legacyBinPath, packageBinPath)
        console.log(`after-pack: renamed ${productName}.bin -> ${packageName}`)
      } else if (fs.existsSync(launcherPath) && isElfBinary(launcherPath)) {
        fs.renameSync(launcherPath, packageBinPath)
        console.log(`after-pack: renamed ${productName} -> ${packageName}`)
      } else {
        console.log(
          "after-pack: no ELF binary found to rename; leaving existing launcher untouched"
        )
      }
    }
    if (fs.existsSync(packageBinPath)) {
      fs.chmodSync(packageBinPath, 0o755)
    }

    // 3. 用同名 shell 脚本替代原来的二进制入口，自动加 --no-sandbox
    //    脚本权限设为 0o755，与原二进制一致，双击文件管理器可直接运行
    const wrapperContent = `#!/usr/bin/env bash
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
for bin in "${packageName}" "${productName}.bin"; do
  if [ -x "./$bin" ]; then
    exec "./$bin" --no-sandbox "$@"
  fi
done
echo "${productName} launcher could not find an executable binary." >&2
exit 1
`
    fs.writeFileSync(launcherPath, wrapperContent, { mode: 0o755 })
    fs.chmodSync(launcherPath, 0o755)
    console.log(`after-pack: created no-sandbox wrapper as ${productName}`)
  } catch (e) {
    console.warn("after-pack: unexpected error", e && e.stack)
  }
}
