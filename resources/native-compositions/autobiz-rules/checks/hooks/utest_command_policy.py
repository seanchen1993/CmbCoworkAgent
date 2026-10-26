"""Read-only rules extracted from hooks/utest_plan_contract.py. See provenance.json."""
from __future__ import annotations
from pathlib import Path

MAVEN_EXECUTABLES = {
    "mvn",
    "mvn.cmd",
    "mvn.bat",
    "mvn.exe",
    "mvnw",
    "mvnw.cmd",
    "mvnw.bat",
    "mvnw.exe",
    "./mvnw",
    ".\\mvnw.cmd",
}


GRADLE_EXECUTABLES = {
    "gradle",
    "gradle.bat",
    "gradlew",
    "gradlew.bat",
    "./gradlew",
    ".\\gradlew.bat",
}


PACKAGE_EXECUTABLES = {
    "npm",
    "npm.cmd",
    "pnpm",
    "pnpm.cmd",
    "yarn",
    "yarn.cmd",
    "bun",
    "bun.exe",
    "npx",
    "npx.cmd",
}


DIRECT_TEST_EXECUTABLES = {
    "pytest",
    "pytest.exe",
    "py.test",
    "jest",
    "jest.cmd",
    "vitest",
    "vitest.cmd",
}


def command_executes_tests(command):
    """Return whether a validation command can execute test cases."""
    if not isinstance(command, dict):
        return False
    argv = command.get("argv")
    if not isinstance(argv, list) or not argv or not all(
        isinstance(item, str) and item for item in argv
    ):
        return False
    executable = Path(argv[0].replace("\\", "/")).name.lower()
    executable_raw = argv[0].lower()
    lowered = [item.lower() for item in argv[1:]]
    if executable in DIRECT_TEST_EXECUTABLES:
        return True
    if executable in {"python", "python.exe", "python3", "python3.exe"} or executable.startswith("python3."):
        if "-m" in lowered:
            module_index = lowered.index("-m") + 1
            return module_index < len(lowered) and lowered[module_index] in {"pytest", "unittest"}
        return False
    if executable in MAVEN_EXECUTABLES or executable_raw in MAVEN_EXECUTABLES:
        if any(value in {"-dskiptests", "-dmaven.test.skip=true", "-dskiptests=true"} for value in lowered):
            return False
        goals = [value for value in lowered if value and not value.startswith("-")]
        return any(value in {"test", "integration-test", "verify", "package", "install"} for value in goals)
    if executable in GRADLE_EXECUTABLES or executable_raw in GRADLE_EXECUTABLES:
        return any("test" in value and not value.startswith("-") for value in lowered)
    if executable in PACKAGE_EXECUTABLES:
        return any(
            value in {"test", "test:unit", "test:integration", "vitest", "jest"}
            or value.startswith("test:")
            for value in lowered
        )
    return False
