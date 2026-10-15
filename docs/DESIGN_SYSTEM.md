# Design system (extracted from pepsinogen.net)

Source: the live single-file site (inline CSS ~51 KB, 247 class selectors). The files under `public/assets/` are the reference copy. Do not redesign; reuse these tokens and components.

## Fonts (embedded in the original, shipped locally in `public/assets/fonts/`)
| Family | Weights | File | Use |
|---|---|---|---|
| Vazirmatn | 400, 500, 700, 800 | `Vazirmatn-{400,500,700,800}.woff2` | all Persian UI text (`--ff`) |
| Great Vibes | 400 | `GreatVibes-400.woff2` | teacher signature (`.sig`) |
| Baloo Brand | 800 | `BalooBrand-800.woff2` | Latin brand wordmark (`pepsino LAB`) |

Fallback stack: `Vazirmatn, -apple-system, "Segoe UI", Tahoma, sans-serif`.

## Logo
- `public/assets/img/logo.png`: round dark-green badge (flask, pencil, ladder, leaves, "GET ACTIVE TO GROW").
- Used through `.plogo` (CSS background) at `.brand-logo` (52px, 44px under 860px).
- Original inline SVG icons (menu, lines, arrows, signature swash and heart) are in the live HTML and are reproduced in `site.css` where used.

## Color tokens
| Token | Value | Role |
|---|---|---|
| `--cream` | #FFF8EA | page background (with radial dot pattern) |
| `--paper` | #FFFDF6 | cards, buttons |
| `--ink` | #4A2E1E | primary text, button borders and shadows |
| `--ink-2` / `--ink-3` | #7B5A44 / #A98D77 | secondary / muted text |
| `--line` / `--line-2` | #EBD9BC / #F3E7CE | borders, dividers |
| `--p10` family | #E0512F, soft #FFE6DE, deep #B93A1C | Grade 10 |
| `--p11` family | #2F8F55, soft #E1F3E6, deep #1F6C3F | Grade 11, "good" |
| `--p12` family | #C99012, soft #FFF1CF, deep #9C6C06 | Grade 12, primary button |
| `--blue` family | #4B8FC9, soft #E4F0FA, deep #2F6A9B | info, drag target |
| `--bad` | #E0512F | errors |

Radii: `--r-lg` 26px, `--r-md` 18px, `--r-sm` 12px, buttons 16px. Shadows: `--shadow`, `--shadow-sm` (3px solid offset), `--shadow-press`.

## Components (selected from the 247 selectors)
- **Buttons:** `.btn` with variants `.primary` (gold), `.dark`, `.ghost`, `.g10/.g11/.g12` (grade-tinted), `.danger`, `.sm`. Hover lifts 1px, press drops 2px, disabled is flat.
- **Tags/pills:** `.tag` (dashed border by default, `.solid`), grade variants, `.pill-status`.
- **Cards and sections:** `.card`, `.sec-head` with a numbered badge (1, 2, …), `.panel`, `.box`, `.ex-card`, `.q-card`.
- **Header:** sticky, cream at 92% opacity with blur; `.brand`, `.brand-txt`, `.ver-chip`, `.top-in`.
- **Navigation:** horizontal links in the header; `.tab` for filters; `.menuBtn` for mobile.
- **Forms:** `.inp`, `.type-switch` (text/image toggle), `.img-slot` (dashed drop area), `.opt-chip` (answer options).
- **Calendar:** `.calendar`, `.cal-cell` (green marks for exam nights), `.night-date`.
- **Results:** `.ring` (score ring), `.stat`, `.stats`, `.count-nums` (countdown), `.cert-strip`, `.table-wrap`.
- **Feedback:** `.toast`, `.modal`, `.zoom-modal` (image zoom), `.storage-bar`.
- **Signature:** `.sig` (Great Vibes name with an animated heart and a red swash).
- **Responsive breakpoints:** 980, 900, 860, 820, 760, 700 px.

## Views (from `view-*` sections)
`view-landing`, `view-home` (exam list, grade tabs, calendar, results lookup), `view-exam` (question screen, answer options, submit), `view-result` (report card, print), `view-varchive` (video archive), `view-admin` (admin panel).

## What is reproduced in this repo
- Tokens, fonts, logo, buttons, cards, header, forms, and responsive base: **done** (`public/assets/site.css`, `public/assets/app.css`).
- Home and admin pages: **partial** (registration, login, approval queue, student list, audit).
- Calendar, exam question screen, report card print, ring/score components, video archive, plan view: **not yet built**. Their CSS exists in `site.css`, so the markup can be added without changing the design.
