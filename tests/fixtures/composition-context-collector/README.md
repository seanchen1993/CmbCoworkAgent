# Composition context integration fixtures

The default `composition-unit-context.integration.test.ts` uses this small tracked business
package and a real Python child process. The collector uses only Python's standard library;
it reads the actual selected knowledge manifest, policies and business facts. The test uses
the production native configuration, directory binding, retained source approval, extension
context preparation and shared composition input identity guards. Knowledge changes,
configuration changes, producer revocation and frozen source tampering invalidate old results.
Neither the collector nor its output is mocked. Python 3 must be available as `python` or via
`CMB_AUTOBIZ_PYTHON`. No npm install, generated ZIP or `output/` dependency cache is required.

This fixture does **not** claim to implement the reviewed AutoBiz adapter. Its catalogue must
have no `autobiz-v1` admission. The original adapter's full inventory and collector cannot be
replaced by a miniature provider without weakening the production trust boundary.

## Explicit original AutoBiz acceptance

The original complete check remains in
`src/main/harness-board/project-runtime/composition-unit-context-autobiz.integration.test.ts`.
Enable it with `RUN_AUTOBIZ_COLLECTOR_INTEGRATION=1`. Enabling it without the following inputs
fails immediately with an explicit missing artifact/dependency diagnostic:

- `AUTOBIZ_COMPOSITION_CONTEXT_ARCHIVE`: the complete reviewed warehouse ZIP. The historical
  default is `output/deliveries/mods-verified-artifacts-20261017-v5/12-数仓可验证产物导出版.zip`.
- `AUTOBIZ_CONTEXT_TEST_DEPENDENCIES`: a prepared `node_modules` directory containing
  `gray-matter@4.0.3` and its transitive dependencies. The historical default is
  `output/creator-context-fixture-deps/node_modules`. Prepare this isolated fixture directory
  deliberately; do not depend on an unrelated user's dependency directory or global install.
- Windows and Python 3, as required by the reviewed legacy composition bridge.

That opt-in case still runs the original Python/JavaScript collector, checks the original
knowledge/configuration fences and frozen producer, verifies unchanged archive bytes, and
preserves the 15-second query budget and four full-source reads per current candidate query.
`CMB_COMPOSITION_CONTEXT_BASELINE=1` additionally runs the historical owner callback comparison
and retains its 21-read diagnostic assertion. The default shared-chain test makes no claim
about those AutoBiz-specific performance counts.

PowerShell example, after explicitly preparing the required fixture inputs:

```powershell
$env:RUN_AUTOBIZ_COLLECTOR_INTEGRATION = "1"
npx vitest run src/main/harness-board/project-runtime/composition-unit-context-autobiz.integration.test.ts --maxWorkers=1
```
