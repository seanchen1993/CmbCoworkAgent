# Grok avatar kernel snapshot

Source: the user-provided Grok Bot renderer, `index.eager-platform-DUN5VkaE.js`.
Source: index.eager-platform-DUN5VkaE.js; formatted source SHA-256: fb22177b9de1db1216a08e6be5fe5feac87f246151427c842756ef42bf0f5237

The snapshot retains the dependency closure of `Yf`, `Nx`, `Fh`, `RE`, and `zE`, plus the body-name mapping used during extraction. It contains the original geometry, expressions, keyframes, state director, SVG tree construction and attribute reconciliation. Local public exports are named at the end; original internal names and numeric data are preserved for traceability.

The closure uses only standard numeric, string, array and collection built-ins. It does not import the Grok application, React, network or process APIs, credentials, storage, listeners or timers. `updateSvg` receives its DOM parent from the CMB adapter. Original bounded geometry caching is retained.

`grok-avatar-adapter.ts` maps the persisted CMB shape and activity names. `BotAvatar.tsx` owns one visibility-gated shared clock and pointer listener, reduced-motion handling and unmount cleanup. Idle settled avatars do not request frames. Runtime state remains owned by the original CMB thread context.

The vendor snapshot comes from the supplied Grok code; the Hermes MIT notice applies to the separate shared clock files, not to this snapshot. Do not merge this code into those files or attribute it to Hermes.

## 0.71.2 gaze timing update

The installed reference renderer `index.eager-platform-DKZJbDqM.js` changes motion `ih`'s gaze interpolation to use elapsed time, through `bx(dt) = 1 - (1 - .14) ** (dt / (1 / 60))`. This snapshot applies that narrow change as `gazeBlend` and passes the already bounded motion delta into gaze advancement. Shape, clip data and the state director remain unchanged. Read-only AST comparison and before/after timing evidence are recorded under the phase-one plan's 1016G item. The earlier source hash above identifies the original formatted snapshot, before this documented update.

## Static workspace entry mark

`src/renderer/src/assets/bot-workspace-mark.svg` is an idle teardrop frame generated from this existing kernel, using the same optical extent as `BotAvatar`. It is the Suspense placeholder for the workbench navigation entry. The entry lazily imports the existing `BotAvatar` module, without loading the Bots workspace or its Runtime. Hover uses the same character geometry and gaze as the workspace; visibility, reduced motion, idle dormancy and teardown remain owned by that one shared avatar clock.

## Static shape selection rings

`src/renderer/src/assets/bot-avatar-rings/*.svg` contains the 13 fixed contour masks
from installed 0.71.2's `Gv` / `Vxe` / `$7e` selection treatment: a 36px body,
3px clearance and 1px ring in a 44px SVG, centered in the existing 48px button.
The masks were generated with that renderer's pure `QN` / `Qh` / `cP` geometry
and existing CMB shape-name mapping. They use no external resources or script;
only these static masks ship, without another geometry engine, runtime cache,
frame callback or event listener. Profile storage and the existing avatar
motion kernel are unchanged.
