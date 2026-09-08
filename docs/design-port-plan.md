# Nodus Design Port Plan

How the `nodus-design/` Figma prototype maps into the Next.js app, and the
rules that keep the shared design language consistent.

## Architecture

```
packages/ui/          reusable design system (framework-agnostic, React-only)
  tokens.css          Tailwind v4 @theme, .dark mood, status palette, gradients
  src/primitives/     icons, button, input, form controls, badges, overlays…
  src/domain/         data panels: file rows, nodes, devices, security tables…
apps/web/             Next.js app (page shells, routing, mock data)
  components/         app-layer shell (sidebar/topbar/app-shell) — uses next/*
  app/(dashboard)/    six routed pages composed from packages/ui
  app/auth/           mock auth wizard (real auth deferred to Phase 7a)
```

The split: **`packages/ui` holds everything visual and reusable; the app layer
holds anything bound to Next.js or page routing.** Sidebar/topbar live in
`apps/web/components` because they read `usePathname()` and render
`next/link` — they are not part of the shared design system.

## Primitives inventory

| File | Purpose |
| --- | --- |
| `icons.tsx` | centralized SVG glyph set, typed `IconName` |
| `button.tsx` | primary/secondary/ghost/destructive/link |
| `input.tsx` | labelled text field |
| `select.tsx` | native styled select |
| `checkbox.tsx` / `toggle.tsx` / `field.tsx` | form controls |
| `badge.tsx` | StatusBadge: synced/pending/conflict/offline/local-only |
| `path-indicator.tsx` | local P2P / relay / relay-buffer / offline |
| `progress.tsx` / `segmented.tsx` | bars + segmented control |
| `overlay.tsx` | Modal + Drawer + header |
| `brand.tsx` | Logo + Avatar |
| `section.tsx` / `setting-row.tsx` | page scaffolding |
| `breadcrumb.tsx` / `pagination.tsx` | navigation widgets |
| `filter-chips.tsx` | Activity filters + transfer status chip |
| `stat-card.tsx` / `empty-state.tsx` | overview + empty panels |

## Domain inventory

`packages/ui/src/domain/` — `file-row`, `file-detail-panel`, `version-list`,
`conflict-modal`, `node-row`, `device-row`, `pairing-modal`, `network-topology`,
`recovery-key-card`, `key-envelope-table`, `device-revocation-list`,
`activity-table`, `storage-usage-bar`, `types.ts`.

## Page map

| Prototype screen | Route | Composition |
| --- | --- | --- |
| Overview | `/overview` | StatCards + NetworkTopology + Quick access |
| Files | `/files` | toolbar + table + detail panel + conflict modal |
| Devices | `/devices` | NodeRows + DeviceRows + PairingModal |
| Activity | `/activity` | FilterChips + ActivityTable |
| Security | `/security` | recovery key + key envelopes + device revocation + topology |
| Settings | `/settings` | theme/sync/danger rows |
| Auth wizard | `/auth` | email → password → TOTP → mock session |
| Pair (existing) | `/pair` | untouched — restyle deferred |

## Conventions

- Every design token lives in `tokens.css`; a CSS class may not hardcode a
  color that has a token (e.g. status colors come from `--status-*` vars).
- Components are tiny and single-purpose; a panel with a table header + rows
  is a small composition, not a prop-explosion.
- New components go to `packages/ui/src/primitives` or `domain`, then are
  exported through the package exports map. `.ts`-only files (e.g. `types.ts`)
  need an explicit `exports` entry — Tailwind/TS wildcard targets can't append
  extensions.
- Dark mode is a designed second mood: `.dark` redefines tokens and the warm
  surface gradients have explicit dark twins (`surface-warm`, `topbar-warm`).
- Auth UI stays a mock until Phase 7a lands opaque server-side sessions —
  never fake a real session in the mock.