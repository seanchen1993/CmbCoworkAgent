/**
 * Test-only code-adoption path classification.
 *
 * Run:
 *   npx tsx tests/adoption-file-policy.spec.ts
 */

import { getTestCodeMatchRule, isTestCodeFile } from "../src/main/services/adoption-file-policy.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function testRecognizedTestPaths(): void {
  const cases: Array<[string, "directory" | "filename"]> = [
    ["test/UserService.ts", "directory"],
    ["tests/api/UserService.ts", "directory"],
    ["src/__tests__/UserService.ts", "directory"],
    ["src\\tests\\UserService.ts", "directory"],
    ["src/UserService.test.ts", "filename"],
    ["src/UserService.test.d.ts", "filename"],
    ["test_user.py", "filename"],
    ["user_test.py", "filename"],
    ["user_test.go", "filename"],
    ["UserServiceTest.java", "filename"],
    ["UserServiceTests.cs", "filename"],
    ["UserServiceTestCase.kt", "filename"],
    ["widget_test.dart", "filename"]
  ]

  for (const [filePath, expected] of cases) {
    assert(getTestCodeMatchRule(filePath) === expected, `${filePath} should match by ${expected}`)
    assert(isTestCodeFile(filePath), `${filePath} should be classified as test code`)
  }
}

function testSpecAndSubstringPathsRemainProduction(): void {
  const cases = [
    "spec/UserService.ts",
    "specs/UserService.ts",
    "src/UserService.spec.ts",
    "src/UserServiceSpec.java",
    "src/Contest.java",
    "src/Latest.ts",
    "src/testimonial.ts",
    "src/test-utils.ts",
    "src/testing/UserService.ts",
    "manual-tests/UserService.ts"
  ]

  for (const filePath of cases) {
    assert(getTestCodeMatchRule(filePath) === null, `${filePath} should remain production code`)
    assert(!isTestCodeFile(filePath), `${filePath} should not be classified as test code`)
  }
}

function main(): void {
  testRecognizedTestPaths()
  console.log("PASS conventional test paths are recognized")
  testSpecAndSubstringPathsRemainProduction()
  console.log("PASS spec and test substrings remain production code")
}

main()
