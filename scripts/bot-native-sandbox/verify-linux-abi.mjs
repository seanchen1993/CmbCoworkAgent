/** Release compatibility gate only. ELF/link provenance is not kernel admission. */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { open, lstat, readdir, realpath } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const coreDependencies = {
  "libc.so.6": "libc6 (>= 2.28)",
  "libm.so.6": "libc6 (>= 2.28)",
  "libdl.so.2": "libc6 (>= 2.28)",
  "libpthread.so.0": "libc6 (>= 2.28)",
  "librt.so.1": "libc6 (>= 2.28)",
  "libutil.so.1": "libc6 (>= 2.28)",
  "libresolv.so.2": "libc6 (>= 2.28)",
  "ld-linux-x86-64.so.2": "libc6 (>= 2.28)",
  "libgcc_s.so.1": "libgcc-s1 | libgcc1 (>= 8)",
  "libstdc++.so.6": "libstdc++6 (>= 8)",
  "libcap.so.2": "libcap2",
  "libssl.so.1.1": "libssl1.1 (>= 1.1.1)",
  "libcrypto.so.1.1": "libssl1.1 (>= 1.1.1)"
}
// Preserve Electron's locked default Depends and declare any additional real
// SONAME below. An unknown/new ABI must be reviewed, never silently published.
const applicationDependencies = {
  ...coreDependencies,
  "libglib-2.0.so.0": "libglib2.0-0",
  "libgobject-2.0.so.0": "libglib2.0-0",
  "libgio-2.0.so.0": "libglib2.0-0",
  "libnss3.so": "libnss3",
  "libnssutil3.so": "libnss3",
  "libsmime3.so": "libnss3",
  "libnspr4.so": "libnspr4",
  "libplc4.so": "libnspr4",
  "libplds4.so": "libnspr4",
  "libX11.so.6": "libx11-6",
  "libX11-xcb.so.1": "libx11-xcb1",
  "libxcb.so.1": "libxcb1",
  "libXcomposite.so.1": "libxcomposite1",
  "libXdamage.so.1": "libxdamage1",
  "libXext.so.6": "libxext6",
  "libXfixes.so.3": "libxfixes3",
  "libXrandr.so.2": "libxrandr2",
  "libXrender.so.1": "libxrender1",
  "libXtst.so.6": "libxtst6",
  "libXi.so.6": "libxi6",
  "libXss.so.1": "libxss1",
  "libxkbcommon.so.0": "libxkbcommon0",
  "libgbm.so.1": "libgbm1",
  "libdrm.so.2": "libdrm2",
  "libdbus-1.so.3": "libdbus-1-3",
  "libatk-1.0.so.0": "libatk1.0-0",
  "libatk-bridge-2.0.so.0": "libatk-bridge2.0-0",
  "libatspi.so.0": "libatspi2.0-0",
  "libcups.so.2": "libcups2",
  "libasound.so.2": "libasound2",
  "libexpat.so.1": "libexpat1",
  "libpango-1.0.so.0": "libpango-1.0-0",
  "libpangocairo-1.0.so.0": "libpangocairo-1.0-0",
  "libcairo.so.2": "libcairo2",
  "libfontconfig.so.1": "libfontconfig1",
  "libfreetype.so.6": "libfreetype6",
  "libgtk-3.so.0": "libgtk-3-0",
  "libgdk-3.so.0": "libgtk-3-0",
  "libgdk_pixbuf-2.0.so.0": "libgdk-pixbuf2.0-0",
  "libuuid.so.1": "libuuid1",
  "libsecret-1.so.0": "libsecret-1-0",
  "libudev.so.1": "libudev1",
  "libz.so.1": "zlib1g",
  "libbz2.so.1.0": "libbz2-1.0",
  "liblzma.so.5": "liblzma5",
  "libmount.so.1": "libmount1",
  "libselinux.so.1": "libselinux1",
  "libnotify.so.4": "libnotify4",
  "libGL.so.1": "libgl1",
  "libEGL.so.1": "libegl1",
  "libGLESv2.so.2": "libgles2"
}
const compare = (a, b) => {
  const left = a.split(".").map(Number),
    right = b.split(".").map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0)
    if (delta) return delta
  }
  return 0
}
export function inspectPrivateHeaders(text) {
  assert.match(text, /file format elf64-x86-64\b/, "Expected x64 ELF output")
  const needed = [...text.matchAll(/^\s*NEEDED\s+(\S+)\s*$/gm)].map((match) => match[1])
  const soname = /^\s*SONAME\s+(\S+)\s*$/m.exec(text)?.[1]
  const paths = [...text.matchAll(/^\s*(?:RPATH|RUNPATH)\s+(\S+)\s*$/gm)].flatMap((match) =>
    match[1].split(":")
  )
  const references = text.split(/^Version References:\s*$/m)[1] ?? ""
  const versions = [
    ...new Set(
      [...references.matchAll(/\b(?:GLIBC|GLIBCXX|CXXABI|GCC|OPENSSL)_[A-Za-z0-9_.]+\b/g)].map(
        (match) => match[0]
      )
    )
  ]
  for (const name of versions) {
    if (name.startsWith("GLIBC_")) {
      assert.match(name, /^GLIBC_\d+(?:\.\d+)+$/, `Unsupported glibc ABI: ${name}`)
      assert.ok(compare(name.slice(6), "2.28") <= 0, `ELF requires ${name}, exceeds GLIBC_2.28`)
    } else if (name.startsWith("GLIBCXX_")) {
      assert.match(name, /^GLIBCXX_\d+(?:\.\d+)+$/)
      assert.ok(compare(name.slice(8), "3.4.25") <= 0, `ELF requires unsupported ${name}`)
    } else if (name.startsWith("CXXABI_")) {
      if (["CXXABI_TM_1", "CXXABI_FLOAT128"].includes(name)) continue
      assert.match(name, /^CXXABI_\d+(?:\.\d+)+$/)
      assert.ok(compare(name.slice(7), "1.3.11") <= 0, `ELF requires unsupported ${name}`)
    } else if (name.startsWith("GCC_")) {
      assert.match(name, /^GCC_\d+(?:\.\d+)+$/)
      assert.ok(compare(name.slice(4), "4.8.0") <= 0, `ELF requires unsupported ${name}`)
    } else
      assert.ok(
        ["OPENSSL_1_1_0", "OPENSSL_1_1_1"].includes(name),
        `ELF requires unsupported ${name}`
      )
  }
  return { needed, soname, paths, versions }
}
async function readExactly(fd, size, position) {
  const bytes = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const result = await fd.read(bytes, offset, size - offset, position + offset)
    assert.ok(result.bytesRead, "Truncated ELF structure")
    offset += result.bytesRead
  }
  return bytes
}
export async function inspectElf(path, objdump = "objdump") {
  const fd = await open(path, "r")
  try {
    const info = await fd.stat()
    assert.ok(info.isFile(), "Expected a regular release file")
    const magic = Buffer.alloc(4)
    const first = await fd.read(magic, 0, 4, 0)
    if (first.bytesRead !== 4 || !magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) return null
    assert.ok(info.size <= 512 * 1024 * 1024, "Oversized ELF file")
    const header = await readExactly(fd, 64, 0)
    assert.equal(header[4], 2, "Release requires 64-bit ELF")
    assert.equal(header[5], 1, "Release requires little-endian ELF")
    assert.equal(header.readUInt16LE(18), 62, "Release requires x64 ELF")
    const offset = Number(header.readBigUInt64LE(32)),
      width = header.readUInt16LE(54),
      count = header.readUInt16LE(56)
    assert.ok(
      Number.isSafeInteger(offset) &&
        width === 56 &&
        count > 0 &&
        count <= 128 &&
        offset + width * count <= info.size,
      "Invalid ELF program table"
    )
    const programs = await readExactly(fd, width * count, offset)
    let interpreter = null
    for (let index = 0; index < count; index++) {
      const item = programs.subarray(index * width, (index + 1) * width)
      if (item.readUInt32LE(0) !== 3) continue
      assert.equal(interpreter, null, "Multiple ELF interpreters")
      const position = Number(item.readBigUInt64LE(8)),
        size = Number(item.readBigUInt64LE(32))
      assert.ok(
        Number.isSafeInteger(position) && size > 1 && size <= 4096 && position + size <= info.size,
        "Invalid ELF interpreter"
      )
      const bytes = await readExactly(fd, size, position)
      assert.equal(bytes.at(-1), 0, "Invalid ELF interpreter terminator")
      interpreter = bytes.subarray(0, -1).toString("utf8")
      assert.equal(interpreter, "/lib64/ld-linux-x86-64.so.2", "Unexpected release ELF interpreter")
    }
    const output = execFileSync(objdump, ["-p", path], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000
    })
    return { ...inspectPrivateHeaders(output), interpreter }
  } finally {
    await fd.close()
  }
}
export async function verifyLinuxAbi({
  directory,
  nativeDirectory = directory,
  objdump = "objdump"
}) {
  const root = await realpath(resolve(directory)),
    native = await realpath(resolve(nativeDirectory))
  assert.ok(
    native === root || native.startsWith(root + sep),
    "Native resources are outside package"
  )
  const paths = []
  let entries = 0
  async function walk(dir) {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      assert.ok(++entries <= 100_000, "Release file inventory exceeds its bound")
      const path = join(dir, item.name),
        stat = await lstat(path)
      assert.ok(!stat.isSymbolicLink(), "Release compatibility inventory cannot follow symlinks")
      if (stat.isDirectory()) await walk(path)
      else if (stat.isFile()) paths.push(path)
    }
  }
  await walk(root)
  const files = []
  for (const path of paths) {
    const result = await inspectElf(path, objdump)
    if (result)
      files.push({
        path: relative(root, path),
        native: path.startsWith(native + sep),
        ...result
      })
  }
  assert.ok(files.length > 0, "No ELF release files were inspected")
  const nativeFiles = files.filter((item) => item.native)
  assert.deepEqual(
    nativeFiles.map((item) => item.path.split(sep).at(-1)).sort(),
    ["bwrap", "codex", "codex-linux-sandbox"],
    "Expected all three native providers"
  )
  const dependencies = new Set(),
    nativeDependencies = new Set(),
    bundled = new Set(files.filter((item) => item.soname).map((item) => item.soname))
  for (const file of files) {
    if (file.native)
      assert.equal(file.paths.length, 0, "Native provider must not use private RPATH/RUNPATH")
    else
      for (const path of file.paths) {
        assert.match(
          path,
          /^\$ORIGIN(?:\/[A-Za-z0-9_.-]+)*$/,
          "Application RPATH must stay beside bundled files"
        )
        assert.ok(!path.split("/").includes(".."), "Application RPATH cannot leave its directory")
      }
    for (const needed of file.needed) {
      if (!file.native && bundled.has(needed)) continue
      const dependency = (file.native ? coreDependencies : applicationDependencies)[needed]
      assert.ok(dependency, `Undeclared ${file.path} dynamic dependency: ${needed}`)
      dependencies.add(dependency)
      if (file.native) nativeDependencies.add(dependency)
    }
  }
  return {
    glibcCeiling: "2.28",
    kernelAcceptance: "not-tested",
    dependencies: [...dependencies].sort(),
    nativeDependencies: [...nativeDependencies].sort(),
    files
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, nativeDirectory] = process.argv.slice(2)
  assert.ok(directory, "Pass release directory and optional native resources directory")
  process.stdout.write(
    JSON.stringify(await verifyLinuxAbi({ directory, nativeDirectory }), null, 2) + "\n"
  )
}
