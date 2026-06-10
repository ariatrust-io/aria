# DESIGN.md

Visual system for ARIA. Two registers, one identity: the landing reads as a
forensic document on paper; the dashboard reads as the operations console that
produces those documents. Both share the verification green, the ink-toward-green
neutrals, Archivo for structure, and JetBrains Mono wherever data or evidence lives.

## Theme

- **Landing (brand register):** light. Paper surface, near-black green-tinted ink,
  one committed deep green that owns the hero and final CTA bands (Committed color
  strategy, 30-60% of the surface).
- **Dashboard (product register):** dark ops console. Depth comes from a 3-step
  surface lightness scale, never from glow shadows or glassmorphism.
- All colors are OKLCH. Neutrals carry 0.003-0.016 chroma toward hue 150-160
  (the brand's own green), never generic warm or cool tints.

## Color

### Landing tokens (index.html)

| Token | Value | Role |
|---|---|---|
| `--paper` | `oklch(98% 0.003 150)` | Body background |
| `--paper-shade` | `oklch(95.5% 0.006 150)` | Alternate section background |
| `--ink` | `oklch(24% 0.015 160)` | Headings, body text |
| `--ink-soft` | `oklch(42% 0.015 160)` | Secondary text (AA on paper) |
| `--green` | `oklch(38% 0.085 155)` | Brand: hero/CTA bands, primary buttons, links |
| `--green-deep` | `oklch(31% 0.07 155)` | Button hover |
| `--red` | `oklch(46% 0.16 27)` | Critical/incident only |
| `--panel` | `oklch(20% 0.02 160)` | Dark code/evidence panels on paper |
| `--rule` / `--rule-strong` | `oklch(86%/70% ~0.01 150)` | Hairline document rules |

### Dashboard tokens (app/index.html)

| Token | Value | Role |
|---|---|---|
| `--bg` | `oklch(15% 0.012 160)` | App background |
| `--surface` / `--surface-2` | `oklch(19%/23% ~0.015 160)` | Cards / hover elevation |
| `--text` / `--text-soft` / `--text-faint` | `oklch(93%/73%/62%)` | Text ramp |
| `--accent` | `oklch(74% 0.11 155)` | Active tab, links, chips |
| `--accent-strong` | `oklch(44% 0.09 155)` | Solid primary buttons |
| `--success` | `oklch(74% 0.13 150)` | Trusted / success |
| `--warning` | `oklch(80% 0.12 85)` | Neutral trust / medium severity |
| `--critical` | `oklch(70% 0.17 25)` | Untrusted / errors / critical |
| `--info` | `oklch(78% 0.07 220)` | "Blocked by ARIA" states |

Rules: semantic colors always pair with a text label (badges spell out
SUCCESS / BLOCKED BY ARIA / SCOPE VIOLATION); never color alone. Accent is for
primary action, selection, and state, never decoration. No gradients, no
gradient text, no side-stripe borders, no glow box-shadows.

## Typography

- **Archivo** (400-800): all UI and display text. Chosen deliberately: a grotesque
  originally designed for archival use, on a product whose job is keeping records.
- **JetBrains Mono** (400-600): every artifact and datum: DIDs, hashes, event
  actions, ledger figures, code, section meta-labels. `tabular-nums` on all numbers.
- Landing headings: fluid `clamp()`, ratio >= 1.25, sentence case (the page never
  shouts). Body 16-17px, max measure ~65ch, `text-wrap: balance` on h1-h3.
- Dashboard: fixed rem-ish scale, tighter ratio (~1.2). Mono for table headers and
  section titles at 11-12px with 0.1em tracking.

## Section grammar (landing)

No eyebrow kickers, no numbered scaffolding. The cadence is document-like:

- Big sentence-case heading + one supporting paragraph.
- **Exhibit A / Exhibit B** labels appear only on the incident-comparison
  documents (a deliberate, named forensic system, used once).
- "How it works" keeps plain 1/2/3 because it is a real sequence.
- Capabilities render as a specification index (name + mono artifact + description
  rows separated by hairlines), not icon cards.
- Verticals render as dossier rows (mono tag / title / description columns).
- Pricing is the only card grid (cards are the honest affordance there): flat,
  hairline borders, featured tier marked by a green border + mono flag.

## Motion

- One orchestrated hero entrance: headline lines rise with `--ease-out`
  (`cubic-bezier(0.16,1,0.3,1)`), then the Signed Event Record types itself.
- Scroll reveals only on the ledger cells and the two exhibits; everything else
  is static by design.
- Dashboard: 150ms color/border transitions only; no entrance choreography.
- Every animation has a `prefers-reduced-motion: reduce` path; the event record
  renders its full transcript statically there.

## Components

- Buttons: 3-4px radius rectangles. Solid (green or paper/ink) primary, 1px
  hairline outline secondary. Hover changes background-color, max 1px translate.
- Focus: 2px green `:focus-visible` outline everywhere.
- Dashboard severity chips (`.pattern-sev`, `.trust-badge`, `.badge-*`): tinted
  background + hairline border + uppercase text label.
- Gate cards: highest-contrast surface on the dashboard; Approve requires a
  confirm step naming the gated action.

## Don'ts (enforced by /impeccable audit)

Indigo/purple gradients, gradient text, glassmorphism, glow-on-dark, identical
icon-card grids, tracked uppercase eyebrows per section, 01/02/03 markers as
decoration, animated stat counters, side-stripe borders, Plus Jakarta Sans/Inter,
em dashes in copy.

## Coverage

All public pages are on these tokens: the landing (`index.html`), the dashboard
(`app/index.html`), and the secondary pages (`pricing.html`, `proof.html`,
`docs.html`, `reset-password.html`, `terms.html`, `privacy.html`,
`acceptable-use.html`, `cookies.html`). Secondary pages use the landing token
set; code samples and the live event stream render on the dark `--panel`
evidence surface. The gate walkthrough on `proof.html` keeps plain 01/02/03
because it is a real sequence, mirroring "How it works" on the landing.
