/** How a code path was classified as test code. */
export type TestCodeMatchRule = "directory" | "filename"

const TEST_DIRECTORY_SEGMENTS = new Set(["test", "tests", "__tests__"])

// Languages that commonly use snake_case test file names such as
// test_user.py / user_test.go. Extension filtering still happens in
// adoption-tracker; this set only prevents an unrelated filename from being
// classified by a convention that its language does not normally use.
const SNAKE_CASE_TEST_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "go",
  "rs",
  "rb",
  "php",
  "c",
  "cc",
  "cpp",
  "h",
  "hpp",
  "m",
  "mm",
  "dart",
  "r"
])

// Case-sensitive suffixes avoid false positives such as Contest.java and
// Latest.ts while covering JVM/.NET/Swift-style FooTest/FooTests names.
const PASCAL_CASE_TEST_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "java",
  "kt",
  "scala",
  "cs",
  "swift",
  "m",
  "mm",
  "php"
])

/**
 * Classify a workspace/repository-relative code path as test code.
 *
 * Deliberately test-only: spec/specs directories, *.spec.* files and *Spec
 * class names remain ordinary production-code adoption events. Matching is
 * boundary-aware; arbitrary substrings such as "contest" or "testimonial"
 * never classify a file as a test.
 */
export function getTestCodeMatchRule(filePath: string): TestCodeMatchRule | null {
  if (!filePath) return null

  const normalized = filePath.replace(/\\/g, "/")
  const segments = normalized.split("/").filter(Boolean)
  if (segments.length === 0) return null

  const directorySegments = segments.slice(0, -1)
  if (directorySegments.some((segment) => TEST_DIRECTORY_SEGMENTS.has(segment.toLowerCase()))) {
    return "directory"
  }

  const fileName = segments[segments.length - 1]
  const lowerFileName = fileName.toLowerCase()
  const extensionSeparator = lowerFileName.lastIndexOf(".")
  if (extensionSeparator <= 0 || extensionSeparator === lowerFileName.length - 1) return null

  const extension = lowerFileName.slice(extensionSeparator + 1)
  const lowerStem = lowerFileName.slice(0, extensionSeparator)
  const originalStem = fileName.slice(0, fileName.length - extension.length - 1)

  // JS/TS and similar ecosystems conventionally use foo.test.ts. The same
  // boundary is safe for every tracked extension and also covers test.ts and
  // compound extensions such as foo.test.d.ts.
  if (lowerStem === "tests" || /(?:^|\.)test\./.test(lowerFileName)) {
    return "filename"
  }

  if (
    SNAKE_CASE_TEST_EXTENSIONS.has(extension) &&
    ((lowerStem.startsWith("test_") && lowerStem.length > "test_".length) ||
      (lowerStem.endsWith("_test") && lowerStem.length > "_test".length))
  ) {
    return "filename"
  }

  if (PASCAL_CASE_TEST_EXTENSIONS.has(extension) && /(?:TestCase|Tests?)$/.test(originalStem)) {
    return "filename"
  }

  return null
}

export function isTestCodeFile(filePath: string): boolean {
  return getTestCodeMatchRule(filePath) !== null
}
