# Byte-identical upstream Mods fixtures

Source: https://github.com/anthropics/claude-code-playground/tree/569c5283d9a0a7ee7938df85bb32e4f48cbb8c86/claude-code/mods

Apache-2.0; original repository LICENSE is included. provenance.json contains original URLs, commit and SHA256 for each runtime file. Only screenshots, upstream READMEs and .gitignore are omitted. Runtime code, manifests and hook declarations are byte-identical. The original full archive remains in output/sparks-ux-redesign-20261010/research/upstream.

Do not rewrite matcher names, SDK calls or UI trees to make local tests pass. The colocated upstream-original-runtime and upstream-native-bridge tests intentionally load these files directly. A test failure is compatibility evidence to diagnose, not permission to alter a fixture. Synthetic host receipts and native handlers are declared in test code and do not count as full Electron/production-process compatibility.
