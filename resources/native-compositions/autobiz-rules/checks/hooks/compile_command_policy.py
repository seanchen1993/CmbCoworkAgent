"""Read-only rules extracted from hooks/code_execution_guard.py. See provenance.json."""
from __future__ import annotations
import re
from pathlib import Path
from hooks.command_executable import executable

def _executable(token: str) -> str:
    return executable(token)


def _maven_arguments(argv: list[str]) -> tuple[list[str], list[str], str | None]:
    goals: list[str] = []
    files: list[str] = []
    values = {"-f", "--file", "-pl", "--projects", "-P", "--activate-profiles", "-D", "--define",
              "-s", "--settings", "-gs", "--global-settings", "-t", "--toolchains", "-gt", "--global-toolchains",
              "-T", "--threads", "-rf", "--resume-from", "-l", "--log-file"}
    index = 1
    while index < len(argv):
        token = argv[index]
        if "$" in token:
            return goals, files, "Maven 参数包含无法确定的运行时变量"
        if token in values:
            if index + 1 >= len(argv) or argv[index + 1].startswith("-"):
                return goals, files, f"Maven 选项 {token} 缺少参数值"
            if token in {"-f", "--file"}:
                files.append(argv[index + 1])
            index += 2
            continue
        if token.startswith("--file=") or token.startswith("-f="):
            files.append(token.split("=", 1)[1])
        elif token.startswith("-f") and len(token) > 2:
            files.append(token[2:])
        elif not token.startswith("-"):
            goals.append(token)
        index += 1
    if any(not path or "$" in path for path in files):
        return goals, files, "Maven -f/--file 必须指定明确的构建文件"
    return goals, files, None


def _production_compile_argv(tokens: list[str]) -> bool:
    if any("$" in token for token in tokens):
        return False
    executable = _executable(tokens[0])
    if executable in {"mvn", "mvnw"}:
        goals, _, error = _maven_arguments(tokens)
        return error is None and "compile" in goals and set(goals) <= {"compile", "clean"}
    if executable in {"gradle", "gradlew"}:
        tasks = {token.rsplit(":", 1)[-1] for token in tokens[1:] if not token.startswith("-")}
        return bool(tasks) and tasks <= {
            "classes", "compileJava", "compileKotlin", "compileGroovy", "compileScala"
        }
    if executable == "go":
        return len(tokens) >= 2 and tokens[1] == "build" and not any(
            token in {"test", "vet", "run", "install"} for token in tokens[1:]
        )
    if executable == "cargo":
        return len(tokens) >= 2 and tokens[1] == "check" and not any(
            token in {"test", "build", "clippy", "bench"} for token in tokens[1:]
        )
    return False
