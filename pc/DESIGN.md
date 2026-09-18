# PC Edition — Design System

> Locked visual system for the Mobile Agent PC web UI, produced under the
> **hallmark** design skill (genre: *atmospheric*, custom-tuned theme
> **“Nightshift”**) and applied in **impeccable · Operate** mode (product UI).
> Source skills: `skills/hallmark/` and `skills/impeccable/`.

## Identity

Mobile Agent's desktop twin keeps the app's DNA — black canvas, Geist,
Geist Mono — and elevates it: warm-tinted ink surfaces instead of flat
gray, a single warm amber accent, quiet elevation instead of borders
everywhere. It should feel like an instrument you keep open after dark:
an agent console, not a chat toy.

- **Genre** — atmospheric (dark AI-tool school)
- **Theme** — Nightshift (custom: mobile-agent brand + warm amber)
- **Mode** — Operate: restrained color, standard affordances, density allowed,
  motion only when it explains state
- **Fonts** — Geist (UI, 400/500/600/700) · Geist Mono (outlier: tool names,
  code, terminal, stats, eyebrows). Bundled locally in `public/fonts/`
  (SIL OFL, © Vercel) so the tool works offline.

## Tokens

All colors are OKLCH and every value in `public/styles.css` flows through a
named custom property — no inline colors, no mid-render improvisation.

### Surfaces (warm-tinted ink — never neutral gray, never pure black)

| Token | Value | Use |
| --- | --- | --- |
| `--paper-0` | `oklch(14% 0.005 80)` | app canvas |
| `--paper-1` | `oklch(17% 0.006 80)` | sidebar, panels, tool cards |
| `--paper-2` | `oklch(20.5% 0.007 80)` | raised cards, inputs |
| `--paper-3` | `oklch(24.5% 0.008 80)` | hover / pressed |
| `--paper-inset` | `oklch(11.5% 0.005 80)` | code blocks, terminal well |
| `--line` / `--line-strong` | `oklch(27%/35% 0.008–0.01 80)` | hairlines |

### Type ramp (fixed rem, 1.125–1.2 ratio)

11 · 12 · 13 · 14 (body) · 16 · 18 · 20 · 24 · 30 px steps.
Display tracking −0.02…−0.03em (never past −0.04). Body line-height 1.55,
display 1.1. Italic never appears in headings.

### Accent & semantics

- `--accent` `oklch(79% 0.135 77)` amber — primary actions, focus rings,
  selection, the working pulse. Never decoration.
- `--ok` green, `--danger` red, `--info` blue — each tinted from its own hue
  with a `-dim` surface variant for cards.
- Contrast: body text ≥ 4.5:1 on every surface; the amber accent carries
  ~7.5:1 on the canvas.

### Motion

150–250 ms, `cubic-bezier(0.2, 0.7, 0.2, 1)`. Motion explains state only:
the indeterminate run banner, the breathing status dot, the streaming caret,
spinners. No page-load choreography. `prefers-reduced-motion` collapses all
of it.

## Component voice

- **Buttons** — one primary (amber), one ghost (raised + hairline), one quiet
  (text-only). Radii 10px; cards 12–16px; pills only for small chips.
- **Tool cards** — the signature component: status icon + mono tool name +
  one-line summary, expandable input/output. Failed cards and shell commands
  open by default.
- **Approvals** — inline gate cards in the transcript (amber-tinted border),
  never a modal-by-reflex. “Always allow” checkbox edits the permission.
- **Composer** — the one elevated surface with an amber focus ring; model
  chip, attach, mode switch live in its bar.
- **Empty states teach** — the home screen is a three-step setup checklist
  plus real example prompts that fill the composer.
- **Browser surfaces** — themed scrollbars, amber selection, amber caret,
  tabular numerals in tool summaries and tables.

## Out of bounds

Gradient text · glassmorphism · purple-blue gradients · Inter · card-in-card
nesting · emoji as icons (Lucide, 1.75 stroke, one system) · side-stripe
borders · bounce easing · invented metrics.
