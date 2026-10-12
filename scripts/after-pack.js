/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs")
const path = require("path")
const { execFile } = require("child_process")
const { promisify } = require("util")
const verifyNativeRelease = require("./bot-native-sandbox/verify-packaged.cjs")

module.exports = async function (context) {
  await verifyNativeRelease(context)
  if (context && context.electronPlatformName === "darwin") {
    const output = fs.realpathSync(context.appOutDir)
    const product = context.packager.appInfo.productFilename
    if (path.basename(product) !== product) throw new Error("Invalid application bundle name")
    const bundle = path.join(output, product + ".app")
    if (!fs.lstatSync(bundle).isDirectory() || fs.realpathSync(bundle) !== bundle)
      throw new Error("Application bundle must be a directory inside the build output")
    // Apple QA1940: metadata copied from source/cache files may invalidate
    // codesigning. Clean only the newly built bundle, before builder signs it.
    // https://developer.apple.com/library/archive/qa/qa1940/_index.html
    await promisify(execFile)("/usr/bin/xattr", ["-cr", bundle], {
      timeout: 120000
    })
    return
  }
  try {
    const isLinux = process.platform === "linux" || process.env.FORCE_AFTER_PACK_LINUX === "1"
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
