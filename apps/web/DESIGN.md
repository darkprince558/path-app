# Path web design direction

Owner: Arielle. This is the agreed visual and UX direction for the landing page and the app in `apps/web/`. The live, interactive version (hero prototype, flip cards, footprint trail, guest-view mockup) is the playbook artifact: https://claude.ai/artifact/Abt1dfRD8khy9gxW5pDNJV (private to Arielle until shared).

## Color

Cream is the page background, green is the main UI color, coral is the accent.

| Token | Hex | Role |
| --- | --- | --- |
| `paper` | `#F3EBD0` | Page background (primary) |
| `surface` | `#FAF5E6` | Cards and sheets on top of paper |
| `forest` | `#2F4A3A` | Primary: text, headings, buttons, active states |
| `coral` | `#F48057` | Accent: route line, pins, highlights, CTA button fill |
| `rust` | `#A8421F` | Coral-colored text and links (coral itself fails as text) |
| `night` | `#121C16` | Background of every 3D view and dark landing bands |
| `sage` | `#A9C4AE` | Primary color in dark mode, contour lines |
| `ink` | `#15221B` | Text on coral buttons |
| `muted` | `#5E6B60` | Secondary text on paper (4.7:1) |

Contrast rules, measured with WCAG ratios:

- Forest on paper 8.1:1. Use for all body text.
- Coral on paper is 2.2:1 and white on coral is 2.6:1. Never use coral for text or put white text on coral.
- Coral buttons use ink text (6.3:1). Coral-flavored text uses rust (5.1:1).
- Point clouds wash out on cream. Render 3D on `night`. Coral on night is 6.7:1, which suits the route line and 3D labels.

## Type

- Display: **Overpass** 800–900 (based on Highway Gothic road-sign lettering).
- Body and UI: **Atkinson Hyperlegible Next** (Braille Institute, designed for low-vision readers).
- Data: **Atkinson Hyperlegible Mono** for coordinates, distances, share IDs.
- Avoid a soft serif. Cream + coral + serif reads as a generic generated landing page.

## Motifs and motion

- The landing hero is the product: the real scan assembles from scattered points, the coral route draws itself, footprints walk it to a destination pin. Use the fixture until a real scan exists.
- Footprints are the landing-page motif: one SVG path in the left gutter, prints revealed with scroll (GSAP ScrollTrigger + MotionPath). Under 40% opacity.
- Inside the app, routes are a coral line with flowing dashes and waypoint dots, not footprints, since some users roll rather than walk.
- One orchestrated animation per landing section. Respect `prefers-reduced-motion` everywhere.
- Booth: a QR in the hero and Join section opens the guest link on the judge's phone. The hero replays after ~20 s idle.

## Landing page sections

Hero (live scan + QR + Log in / Sign up) → The problem (sticky scroll: 2D floor plan tilts into 3D, one measured stat) → Our product (Scan · Share with Public/Unlisted/Private · Navigate with landmark cues, real screenshots) → How to use (3 steps joined by footprints) → Creators (flip cards: hover on desktop, tap on iPhone, focus on keyboard; GitHub, LinkedIn, résumé, portfolio) → Join us (trail ends at a pin by the CTA and QR).

## App screens, by priority

- **P0:** guest view at `/s/:shareId` (full-bleed 3D on night, destinations in a bottom sheet, Gemini cue card with source frame and "approved by the map owner", route by Dijkstra over the manifest graph) · upload with visibility toggle, copy link and QR · Gemini cue review (accept / edit / reject) · landing hero.
- **P1:** rest of the landing page · Explore (public scans + filter chips: Campus, Events, Hospitals, Trails, Step-free) · settings (step-free routing, text size, reduce motion) · one "elevator out" alert that reroutes.
- **Cut or fake:** custom login screens (use the provider's hosted login), comments and feed, events calendar, live indoor positioning.

## Stack

Vite + React + TypeScript + Tailwind v4 + React Router, built to static files.

| Job | Library |
| --- | --- |
| 3D viewer | `three`, `@react-three/fiber`, `@react-three/drei` (PLYLoader, CameraControls, Line, Html) |
| Scroll story, footprints | `gsap`, `@gsap/react` (ScrollTrigger, MotionPath, DrawSVG) |
| UI motion | `motion` |
| Landing smooth scroll | `lenis` (off in the app and under reduced motion) |
| Components | shadcn/ui (Radix) |
| Bottom sheet | `vaul` |
| Toasts, QR, icons | `sonner`, `qrcode.react`, `lucide-react` |
| Showpieces | Two or three restyled snippets from Magic UI, Aceternity UI or React Bits |

Mobile targets: the guest link opens signed out in under 3 s on an iPhone; cap device pixel ratio at 2 and downsample large PLYs. Hosting is proposed on Vultr behind Caddy, which must serve `index.html` for `/s/<shareId>` so direct links don't 404.
