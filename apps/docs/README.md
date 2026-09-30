# Nodus Documentation

The official documentation site for [Nodus](../../README.md), built with
[Fumadocs](https://fumadocs.dev) on Next.js.

## Development

From the repository root:

```bash
pnpm --filter docs dev     # http://localhost:3001
```

Or from `apps/docs`:

```bash
pnpm dev
```

## Content

All pages are MDX files under [`content/docs`](./content/docs). Each directory
can contain a `meta.json` that controls the sidebar title and page order. The
page tree is compiled into `lib/source.ts` at build time.

## Structure

| Path | Purpose |
| --- | --- |
| `content/docs` | Documentation content (MDX + `meta.json`) |
| `app/(home)` | Landing page |
| `app/docs` | Docs layout and catch-all MDX renderer |
| `app/api/search` | Full-text search endpoint |
| `components/mdx.tsx` | MDX component map |
| `lib/source.ts` | Fumadocs content source |
| `lib/layout.shared.tsx` | Shared nav/layout options |

## Build

```bash
pnpm --filter docs build      # production build
pnpm --filter docs lint       # eslint
pnpm --filter docs check-types # tsc
```
