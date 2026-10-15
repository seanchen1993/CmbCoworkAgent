# Grok avatar kernel snapshot

Source: the user-provided Grok Bot renderer, `index.eager-platform-DUN5VkaE.js`.
Source: index.eager-platform-DUN5VkaE.js; formatted source SHA-256: fb22177b9de1db1216a08e6be5fe5feac87f246151427c842756ef42bf0f5237

The snapshot retains the dependency closure of `Yf`, `Nx`, `Fh`, `RE`, and `zE`, plus the body-name mapping used during extraction. It contains the original geometry, expressions, keyframes, state director, SVG tree construction and attribute reconciliation. Local public exports are named at the end; original internal names and numeric data are preserved for traceability.

The closure uses only standard numeric, string, array and collection built-ins. It does not import the Grok application, React, network or process APIs, credentials, storage, listeners or timers. `updateSvg` receives its DOM parent from the CMB adapter. Original bounded geometry caching is retained.

`grok-avatar-adapter.ts` maps the persisted CMB shape and activity names. `BotAvatar.tsx` owns one visibility-gated shared clock and pointer listener, reduced-motion handling and unmount cleanup. Idle settled avatars do not request frames. Runtime state remains owned by the original CMB thread context.

The vendor snapshot comes from the supplied Grok code; the Hermes MIT notice applies to the separate shared clock files, not to this snapshot. Do not merge this code into those files or attribute it to Hermes.
