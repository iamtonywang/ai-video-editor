This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Dev: run the worker

Some features (e.g. `build_identity`) enqueue BullMQ jobs that are processed by a separate worker process.

- **Terminal 1**:

```bash
npm run dev
```

- **Terminal 2**:

```bash
npm run worker
```

- **Optional (single command)**:

```bash
npm run dev:all
```

If the worker is not running, jobs will remain in **`queued`** and the Job Status panel may not advance (`queued → running → success/failed`), and `latest_event` may stay empty.

## Supabase Storage (`project-media`)

**Full spec:** **[docs/storage-conventions.md](./docs/storage-conventions.md)** (reference **input** paths, preview **output** paths, and `jobs.output_asset_key`).

| Topic | Convention |
|--------|------------|
| **Bucket** | `project-media` (create in Supabase dashboard) |
| **Reference (input)** | `projects/{projectId}/references/…` → `source_assets.asset_key` (via `/api/source/register`) |
| **Preview (image output)** | `projects/{projectId}/previews/{jobId}/preview.{ext}` with `ext` ∈ `png`, `webp`, `jpg` → **`jobs.output_asset_key`** (no bucket prefix) |
| **After reference upload** | `asset_type: reference`, `asset_status: validated` |

**Important:** `asset_status: uploaded` does **not** satisfy current `identity` / execution-context checks; use `validated` until a real validation pipeline exists. Preview generation is **not** wired yet; the doc defines the **target** layout before placeholder is replaced.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
