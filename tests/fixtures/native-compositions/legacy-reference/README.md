# Original AutoBiz reference code

These unchanged source files pin the original implementation used by the native
knowledge-selection and secret-predicate equivalence tests. They are test references,
not runtime entry points. No configuration, credentials, or complete plugin is included.

Source: `output/deliveries/autobiz-requirements-composition-20261023-r13/revision-2/complete-plugin/`.
That reviewed delivery was derived from the supplied `autobiz_kanban_workspace.zip`.
Tests read the retained files here and do not require the ignored delivery directory.

| Retained file | Original relative path | SHA-256 |
| --- | --- | --- |
| `collect-knowledge.js` | `hooks/collect-knowledge.js` | `405c948b60ea7c79d255c9795697255dbe5f5c4ac1290a2a135fcba5e39d840f` |
| `check-secrets-new.py` | `hooks/check-secrets-new.py` | `38214433b6e305974e81a35c5768f98b6ddd199421c56395c58de6ae90662d2f` |

The collector's only external package dependency is `gray-matter`. Tests reuse the
already tracked `resources/mods/autobiz-knowledge/collector-gray-matter.cjs`, which is
byte-identical to the original delivery's
`mods/business/autobiz.knowledge/collector-gray-matter.cjs`:
SHA-256 `a18fe1c53ab582a75ca3818a5eddf4109efa787594e571324ffe41cd899aceb1`.
Its existing third-party notices remain beside that shared file.
The tests verify all three hashes before executing the references. The collector's
filesystem, app-type lookup, and HTTP interfaces are isolated by the test harness;
network access is rejected. Secret-check debug output is captured rather than exposed.

Both retained originals use LF. The repository's native-composition fixture attributes
preserve these exact bytes across checkout; do not format or rewrite the reference code.

The unchanged `performance_checker.py` reference pins the original seven pure rules.
Source: `hooks/performance_checker.py` in the same reviewed delivery; SHA-256
`2f314041ae5a8ac0146f33d85cacecc693191d6b62be6b3a40ef181fd4b23ae6`.
Tests evaluate only its rule definitions with standard-library dependencies; the old
checkpoint, workspace lookup, and CLI entry points are never executed.
