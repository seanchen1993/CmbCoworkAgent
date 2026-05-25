---
name: Neutral Modern
description: A brand-grade neutral design system for software products, operator dashboards, docs, and B2B websites.
category: Core
source: custom
license: internal
---

# Neutral Modern

A brand-grade neutral system for serious software surfaces. It should feel precise, calm, and expensive without looking decorative.

## Visual Theme & Atmosphere
Use white and near-white surfaces, ink-black hierarchy, measured spacing, and very limited accent color. The system should read as product-led, trustworthy, and fast to scan.

## Color Palette & Roles
```css
:root {
  --bg: oklch(98.5% 0.004 255);
  --surface: oklch(100% 0 0);
  --fg: oklch(17% 0.012 255);
  --muted: oklch(52% 0.012 255);
  --border: oklch(91% 0.006 255);
  --accent: oklch(54% 0.16 250);
  --accent-soft: oklch(94% 0.035 250);
  --success: oklch(56% 0.15 155);
  --warning: oklch(68% 0.16 75);
  --danger: oklch(58% 0.2 25);
}
```

## Typography Rules
Use Inter, Geist, or system sans. Display headings are 40-64px on marketing pages, 18-28px inside product panels. Body text is 14-16px with 1.45-1.65 line-height. Use tabular numerics for metrics.

## Component Stylings
Buttons are 36-44px high with 8px radius. Primary buttons use black or the accent only. Cards use a 1px border, 8px radius, and no decorative glow. Inputs and filters should be compact and aligned to a grid.

## Layout Principles
Prefer 12-column desktop grids, dense product panels, clear section bands, and fixed-size toolbars. Avoid nested cards and oversized empty marketing composition for operational UI.

## Depth & Elevation
Use borders first. Shadows are reserved for command menus, modals, and floating inspectors.

## Do's and Don'ts
Do show real product state, data tables, charts, screenshots, and controls. Do not use emoji icons, vague feature cards, purple-blue hero gradients, or placeholder stats.

## Responsive Behavior
Collapse to one column below 760px. Preserve primary actions and filters near the top. Keep touch targets at least 40px.

## Agent Prompt Guide
Bind the tokens to CSS variables and build a shipped software interface. Content should be concrete, quiet, and immediately usable.
