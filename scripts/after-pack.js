/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const fs = require("fs")
const path = require("path")

module.exports = async function (context) {
  try {
    const isLinux = process.platform === "linux" || process.env.FORCE_AFTER_PACK_LINUX === "1"
    if (!isLinux) {
      console.log(`after-pack: not running because platform is ${process.platform} (only runs on 'linux')`)
      return
    }

    const appOutDir = context && context.appOutDir ? context.appOutDir : process.env.APP_OUT_DIR
    if (!appOutDir) {
      console.log("after-pack: no appOutDir provided, skipping")
      return
    }

    const productName = (context && context.packager && context.packager.appInfo && context.packager.appInfo.productFilename) || "CMBDevClaw"
    const realBinPath = path.join(appOutDir, productName)
    const tmpBinPath = path.join(appOutDir, `${productName}.bin`)

    // 1. 删除 chrome-sandbox，避免 SUID 权限报错
    const sandboxPath = path.join(appOutDir, "chrome-sandbox")
    if (fs.existsSync(sandboxPath)) {
      fs.rmSync(sandboxPath)
      console.log("after-pack: removed chrome-sandbox from", sandboxPath)
    }

    // 2. 把真正的二进制重命名为 CMBDevClaw.bin
    if (fs.existsSync(realBinPath)) {
      fs.renameSync(realBinPath, tmpBinPath)
      console.log(`after-pack: renamed ${productName} -> ${productName}.bin`)
    }

    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf-8"))
    const packageName = packageJson.name

    // 3. 用同名 shell 脚本替代原来的二进制入口，自动加 --no-sandbox
    //    脚本权限设为 0o755，与原二进制一致，双击文件管理器可直接运行
    const wrapperContent = `#!/bin/bash\nDIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"\ncd "$DIR"\nexec "./${packageName}" --no-sandbox "$@"\n`
    fs.writeFileSync(realBinPath, wrapperContent, { mode: 0o755 })
    console.log(`after-pack: created no-sandbox wrapper as ${productName}`)

  } catch (e) {
    console.warn("after-pack: unexpected error", e && e.stack)
  }
}
