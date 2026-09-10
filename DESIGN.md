---
name: NorthKeep Meridian
description: A warm editorial workspace for private memory review and deliberate decisions.
colors:
  canvas: "#f6f4ef"
  surface: "#fffdf8"
  ink: "#24221c"
  muted: "#8a8477"
  muted-curation: "#6d675c"
  line: "#e6e0d4"
  accent: "#2f6a54"
  accent-ink: "#fdfcf7"
  chip: "#efeadd"
  warning-surface: "#f2ede0"
  warning-ink: "#6f5a2c"
  danger: "#b0402b"
  dark-canvas: "#1b1913"
  dark-surface: "#24211a"
  dark-ink: "#ece7db"
  dark-muted: "#a39a88"
  dark-line: "#38332a"
  dark-chip: "#2f2b21"
  dark-accent: "#5f9d83"
  dark-accent-ink: "#14170f"
typography:
  display:
    fontFamily: "Newsreader, Georgia, Iowan Old Style, Palatino Linotype, Times New Roman, serif"
    fontSize: "34px"
    fontWeight: 500
    lineHeight: 1.08
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Newsreader, Georgia, Iowan Old Style, Palatino Linotype, Times New Roman, serif"
    fontSize: "27px"
    fontWeight: 500
    lineHeight: 1.15
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Hanken Grotesk, -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica Neue, Arial, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Hanken Grotesk, -apple-system, BlinkMacSystemFont, Segoe UI, Helvetica Neue, Arial, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "0.08em"
rounded:
  tag: "5px"
  control: "10px"
  inset: "12px"
  surface: "14px"
  pill: "999px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "28px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "9px 16px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "9px 16px"
  field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "9px 13px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.surface}"
    padding: "15px 18px"
  chip-active:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.pill}"
    padding: "3px 11px"
---

# Design System: NorthKeep Meridian

## Overview

**Creative North Star: "The Meridian Reading Desk"**

NorthKeep is a calm, private reading workspace rather than a generic dashboard. Warm paper surfaces, restrained evergreen accents, editorial serif headings, and compact sans-serif controls keep attention on evidence and exact wording. Density is purposeful: the interface may show substantial source material, but hierarchy and generous reading space prevent it from feeling operationally noisy.

The system preserves NorthKeep's incumbent identity. New screens should extend its warm Meridian world, familiar navigation, and evidence-first interaction language instead of introducing a new brand layer.

**Key Characteristics:**

- Warm, paper-like light and dark surfaces
- Editorial headings paired with quiet, highly legible controls
- Evergreen reserved for selection, progress, focus, and affirmative action
- Evidence and proposed output kept visibly separate
- Responsive queue-to-detail reading flow

## Colors

The palette is warm and low-chroma, with evergreen as the sole affirmative accent and ochre/rust reserved for warning and danger.

### Primary

- **Meridian Evergreen:** Drives primary actions, focus, progress, active rails, and selected chips.

### Secondary

- **Archive Ochre:** Communicates bounded warnings and review context without competing with affirmative green.
- **Restoration Rust:** Marks destructive, unavailable, and error states.

### Neutral

- **Warm Canvas / Paper Surface:** Establish the page and elevated reading planes.
- **Charcoal Ink / Quiet Taupe:** Carry primary and supporting copy.
- **Parchment Line / Oat Chip:** Separate regions through borders and tonal layering.
- **Curation Muted:** Replaces the general light-theme muted tone inside `#view-memories`, `#view-curation` and `#curationDialogOverlay`; it is a scoped readability correction, not a global palette change.

### Named Rules

**The One Accent Rule.** Evergreen signals action or state; do not add competing decorative accents.

**The Scoped Contrast Rule.** Use the stronger light muted tone in Memories, curation and its dialog, as verified in the preview parity pass.

## Typography

**Display Font:** Newsreader (with Georgia and traditional serif fallbacks)
**Body Font:** Hanken Grotesk (with system sans-serif fallbacks)
**Label/Mono Font:** Hanken Grotesk for labels and provenance; system monospace for code and technical values

**Character:** Newsreader gives important decisions a composed editorial voice. Hanken Grotesk keeps dense controls, provenance and evidence legible, while monospace is reserved for code or machine-shaped content.

### Hierarchy

- **Display** (500, display token): Curation page statements; reduces to 29px on narrow screens.
- **Headline** (500, headline token): Review questions and major workspace headings.
- **Title** (500, 20–22px, compact line-height): Product mark and collection summaries.
- **Body** (400, body token): Interface copy and source evidence; explanatory text is generally capped near 58–70ch.
- **Label** (600, label token, uppercase): Queue headings, field labels, and terse status categories.

### Named Rules

**The Editorial Hierarchy Rule.** Serif marks the reading decision; sans-serif handles the surrounding operation.

## Layout

Desktop uses a sticky 212px navigation rail and centered content. Memories and Review expand to 1500px; other views cap at 840px. Memories contains its collection navigation rather than treating Collections as a destination: a 240px collection rail sits beside the memory pane on desktop. Review uses a 240px scrollable suggestion queue beside an evidence workspace, where source memories and the proposed memory form a two-column comparison with the proposal slightly wider.

At 720px the navigation rail becomes a wrapped horizontal navigation region; disclosed Connect or Settings children occupy their own horizontal row. At 600px, the collection rail is replaced by the native collection select, and Review becomes a queue-first sequence: selecting a suggestion hides the queue, exposes the detail with a back control, and stacks source evidence before the proposed-memory editor. Controls involved in review maintain a 44px minimum target.

## Elevation & Depth

Meridian is flat by default. Borders, warm tonal shifts, and inset evergreen selection rails establish hierarchy. A conventional ambient shadow appears only on modal dialogs (`0 12px 40px rgba(0,0,0,.18)`), over a blurred, canvas-tinted overlay.

### Named Rules

**The Reading Plane Rule.** Use tonal layering and fine borders for persistent regions; reserve floating elevation for interruptive confirmation.

## Shapes

Shapes are softly utilitarian: 10px controls, 12px inset proposal regions, 14px cards/dialogs, and fully rounded pills. Queue rows remain structurally square at their outer edges, using a bottom rule and inset active rail rather than becoming standalone cards. Source memories are separated by rules so long evidence reads as a document, not a tile collection.

## Components

### Buttons

- **Shape:** Gently curved controls with a 10px radius and 44px minimum review target.
- **Primary:** Evergreen fill with the theme's accent-ink text and matching border: near-white in light mode and dark ink in dark mode.
- **Hover / Focus:** Hover remains restrained; keyboard focus uses a 3px translucent evergreen outline with 2px offset.
- **Secondary / Danger:** Secondary actions use paper fill and a parchment border. Danger actions keep the neutral surface and use rust text/border.

### Chips

- **Style:** Fully rounded, compact filters with paper fill and quiet text.
- **State:** Selected chips fill evergreen; status pills use subdued semantic surfaces rather than saturated badges.

### Cards / Containers

- **Corner Style:** Soft 14px corners for conventional cards and dialogs.
- **Background:** Paper surface over warm canvas; inset review regions use the oat chip tone.
- **Shadow Strategy:** Flat except for modal dialogs.
- **Border:** One-pixel parchment rules.
- **Internal Padding:** Common cards use 15px vertical and 18px horizontal padding.

### Inputs / Fields

- **Style:** Paper fill, one-pixel rule, 10px radius, inherited body type.
- **Focus:** Global evergreen focus ring; the review editor also carries a quiet green border.
- **Error / Disabled:** Errors use restoration rust; disabled controls retain shape and reduce opacity to 50%.

### Navigation

The main navigation is a persistent left rail on desktop and a wrapped horizontal region below 720px. Active items receive an oat background, stronger ink, semibold weight, and a 2px inset evergreen rail. The top level is Memories, Review, a collapsed Connect disclosure, and Settings. Connect reveals Desktop and Cloud; Settings reveals Models, Import, Activity, Tools, Sync, and About. Collections belongs inside Memories through the 240px desktop rail or native mobile select. Legacy chat data may remain available to the product, but Legacy chat is not a navigation destination.

### Suggestion Queue and Evidence Workspace

The vertical queue is the signature Meridian review pattern. From Memories, **Review collection** opens the primary guided Review flow with the eligible private collection already selected. Rows use a divider-led list, at least 94px in curation, with muted metadata, an ink title, and a 3px inset evergreen rail for the current item. Detail always separates **Source memories** from **Proposed memory**, keeps explanation outside editable text, and uses an oat inset panel for the proposed result.

## Do's and Don'ts

### Do:

- **Do** preserve the main sidebar and the distinct 240px Memories collection rail or 240px Review suggestion queue on wide screens.
- **Do** show full source evidence before an editable proposed memory on narrow screens.
- **Do** keep exact wording, explanation, and source membership visually distinct.
- **Do** support both warm light and warm dark palettes with the same semantic hierarchy.
- **Do** preserve the inspected desktop and 390px layouts in dark and light. The light sample forced the existing light CSS; automatic OS theme switching remains unverified.

### Don't:

- **Don't** restore Collections or Legacy chat as top-level navigation destinations; keep collection access in Memories and retain Legacy chat data without a nav item.
- **Don't** flatten Desktop, Cloud, or Models into top-level destinations; keep Desktop and Cloud under Connect and Models under Settings.
- **Don't** turn evidence-heavy review rows into a decorative card grid.
- **Don't** put explanatory model text inside the proposed-memory editor.
- **Don't** expand the Memories/curation light muted override into unrelated surfaces without review.
