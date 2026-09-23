# Compatibility inventory update — 2026-09-23

Baseline: 1584c03c. Upstream pinned official v2.1.278 source declaration (header v2.1.277),
SHA AC107A37C08AD46F8632EDC1639B13A740FAE0B8249A2245532ADFD325E57D0D.

- Inventory all 15 render sites, including terminal-only ToolProgress; counts and unique names checked.
- Twelve tested desktop sites (Pane plus eleven non-Pane sites), isolated Svg, and prompt feedback
  are adapted with explicit differences/evidence. Pending consumers remain partial or unsupported.
- Updated native tool schema, main model selection, actual compaction and source-breakdown notes
  to match implemented behavior; no declaration is marked full solely from API name.
- Tests: five compatibility inventory cases pass; newly asserted site/feedback rows failed before
  their updates. Existing evidence paths all resolve. Feature reports carry real guest/Electron tests.
- Matrix remains implementation-in-progress-not-full-parity. Final performance, Autobiz business
  demonstration and GitHub Actions package acceptance are not implied by this inventory.
