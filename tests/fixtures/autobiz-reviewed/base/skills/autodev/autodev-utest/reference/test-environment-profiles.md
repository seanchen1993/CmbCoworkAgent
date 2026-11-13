# Test environment profiles

Apply a profile only when `inspect_test_environment.py` returns `status=init_required`. Preserve the detected build tool, package manager, runner, manifest style, and matching lock file.

## spring-maven-junit

- Add `spring-boot-starter-test` with test scope to `pom.xml` through the existing dependency-management convention.
- For the `security` domain, add `spring-security-test` when it is not already supplied by the project dependency graph.
- Run tests with the repository's Maven wrapper when present, otherwise Maven.

## spring-gradle-junit

- Add `spring-boot-starter-test` through the existing Gradle DSL and enable JUnit Platform when the project requires it.
- For the `security` domain, add `spring-security-test` when it is not already supplied by the project dependency graph.
- Run tests with the repository's Gradle wrapper when present, otherwise Gradle.

## vue3-vite-vitest

- Add Vitest, `@vue/test-utils`, and the project's chosen DOM environment (`jsdom` or `happy-dom`).
- Add a minimal Vitest config/setup only when the current Vite config cannot host the test settings.
- Add `test:unit` using Vitest when no equivalent unit-test script exists.

## react-vite-vitest

- Add Vitest, React Testing Library, `@testing-library/user-event`, `@testing-library/jest-dom`, and the project's chosen DOM environment (`jsdom` or `happy-dom`).
- Add a minimal Vitest config/setup only when the current Vite config cannot host the test settings.
- Add `test:unit` using Vitest when no equivalent unit-test script exists.

After manifest edits, update only the lock file for the detected `packageManager`, rerun the inspector, then run the smallest test command directly in Bash and register its captured output through `run_utest_command.py --record-only`.
