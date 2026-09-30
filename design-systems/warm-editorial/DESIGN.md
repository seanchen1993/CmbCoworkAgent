---
name: Warm Editorial
description: A brand-grade warm editorial system for content-rich product pages, blogs, decks, and boutique SaaS storytelling.
category: Core
source: custom
license: internal
---

# Warm Editorial

A refined editorial system with human warmth, strong reading rhythm, and product credibility. It should feel authored, not templated.

## Visual Theme & Atmosphere
Use warm paper canvas, ink text, restrained terracotta accents, and generous editorial spacing. Let typography and composition carry the brand.

## Color Palette & Roles
```css
:root {
  --bg: oklch(97.5% 0.018 83);
  --surface: oklch(99% 0.01 83);
  --fg: oklch(18% 0.018 65);
  --muted: oklch(47% 0.025 65);
  --border: oklch(88% 0.025 78);
  --accent: oklch(58% 0.13 35);
  --accent-soft: oklch(92% 0.045 45);
  --deep: oklch(25% 0.04 50);
  --gold: oklch(71% 0.11 78);
}
```

## Typography Rules
Use a serif display face for hero and editorial headings, paired with a humanist sans for UI and body. H1 can be 52-76px on desktop. Body text should be 17-19px for articles and 15-16px for product UI.

## Component Stylings
Primary CTAs use terracotta or deep ink. Secondary actions are underlined text links or quiet bordered buttons. Cards should feel like editorial plates, not SaaS tiles.

## Layout Principles
Use asymmetric grids, measured whitespace, strong pull quotes, side notes, and image/copy pacing. Keep product UI examples crisp and grounded.

## Depth & Elevation
Use paper-like layering, soft borders, and almost no shadow. Depth should come from scale, contrast, and spacing.

## Do's and Don'ts
Do use real headlines, paragraphs, proof, and narrative structure. Do not overuse beige monochrome, random script fonts, bokeh backgrounds, or generic lifestyle copy.

## Responsive Behavior
On mobile, keep text columns comfortable, reduce display scale, and preserve editorial pacing with clear section breaks.

## Agent Prompt Guide
Bind the tokens to CSS variables. Produce an authored, premium editorial interface with concrete copy and restrained warmth.
