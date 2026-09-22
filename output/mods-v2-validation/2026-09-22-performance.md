# Mods v2 performance and disabled-mode comparison — 2026-09-22

The bounded evidence capture loop was measured over five iterations on a temporary 10,000-byte file. Enabled capture (file enumeration, stable read, hashing and binding) took **395.79 ms total**; the disabled-mode loop took **0.0003 ms total**. Raw output is `2026-09-22-performance.log`.

This is a smoke comparison, not the final 5×1000 long-running qualification. It demonstrates that `off` does not invoke evidence capture, while the enabled path pays only for the configured scope.
