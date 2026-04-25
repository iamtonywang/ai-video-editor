# Supabase Storage — `project-media` conventions

This document defines object layouts under bucket **`project-media`** for:

- **Reference** — user/editor **input** material (registered in **`source_assets`**).
- **Preview** — **generated image** output from a preview job (path stored on **`jobs.output_asset_key`**).

Implementations must follow these paths. **The real preview image generation engine is not connected yet**; the worker still ends preview jobs with a **placeholder** `output_asset_key`. When generation is implemented, outputs should **conform to the preview rules below** (replacing the placeholder).

---

## Bucket (dashboard setup)

| Item | Value |
|--------|--------|
| **Bucket name** | `project-media` |

Create the **`project-media`** bucket in the Supabase project dashboard (Storage). Policies/RLS are not defined in this repo—configure them when implementing upload or worker-side writes.

---

## Reference assets (phase 1) — **input material**

**Role:** Reference images (or other inputs) supplied for identity / gate flows — **not** model-generated previews.

**Registration:** After upload, `POST /api/source/register` with `asset_type: reference` and `asset_status: validated` (see below).

### Object path rule

```text
projects/{projectId}/references/{uuid}.{ext}
```

Where:

- **`{projectId}`** — Project UUID (`projects.id`).
- **`{uuid}`** — A stable, collision-safe id for the object basename (implementation may use a short id such as `ref_` + hex; **do not** embed the raw original client filename in the path).
- **`{ext}`** — Normalized extension (`png`, `jpg`, `webp`, …) from MIME or an allowlist.

**Example object key (inside the bucket, no bucket prefix):**

```text
projects/a1b2c3d4-e5f6-7890-abcd-ef1234567890/references/ref_a1b2c3d4.png
```

### `asset_key` for `POST /api/source/register`

Store **`asset_key` as the object path only** — **without** the bucket name or a leading slash:

- **Correct:** `projects/{projectId}/references/….png`
- **Incorrect:** `project-media/projects/…`
- **Incorrect:** `/projects/…`

### After upload — registration rule

| Field | Value |
|--------|--------|
| `asset_type` | `reference` |
| `asset_status` | `validated` |

`execution-context` / `identity/build` expect validated/active reference rows; **`uploaded` alone is not enough**.

---

## Preview job outputs (phase 1) — **generated image**

**Role:** **Output** of a **`preview`** job — **generated result**, not user reference uploads.

**Constraints (phase 1):**

- **Medium:** **image only** (no video preview in this phase).
- **Allowed file extensions:** **`png`**, **`webp`**, **`jpg`** (choose one per object; match MIME when writing).

### Object path rule

All preview image objects for a job live under:

```text
projects/{projectId}/previews/{jobId}/preview.{ext}
```

Where:

- **`{projectId}`** — Project UUID.
- **`{jobId}`** — The **`jobs.id`** UUID for this preview job (one folder per job).
- **`preview.{ext}`** — Literal basename **`preview`** plus extension **`png`**, **`webp`**, or **`jpg`**.

**Example object key (no bucket prefix):**

```text
projects/a1b2c3d4-e5f6-7890-abcd-ef1234567890/previews/f47ac10b-58cc-4372-a567-0e02b2c3d479/preview.webp
```

### `jobs.output_asset_key`

When a preview completes and a file exists in Storage, set **`jobs.output_asset_key`** to the **same string as the object path inside `project-media`** — **do not** include the bucket name or a leading slash:

- **Correct:** `projects/{projectId}/previews/{jobId}/preview.webp`
- **Incorrect:** `project-media/projects/…`

---

## Reference vs preview (summary)

| | **Reference** | **Preview** |
|---|----------------|-------------|
| **Meaning** | **Input** material the user/editor provides | **Generated result** of a preview job |
| **Typical flow** | Upload → `source_assets` via `/api/source/register` | Worker (or pipeline) writes image → update `jobs.output_asset_key` |
| **Path prefix** | `projects/{projectId}/references/…` | `projects/{projectId}/previews/{jobId}/…` |
| **Primary DB link** | `source_assets.asset_key` | `jobs.output_asset_key` |

Do **not** store preview outputs under `references/` or register them as `reference` rows unless they are truly reference inputs.

---

## Caveats (read before implementing)

1. **Reference `uploaded` status** — `execution-context` / `identity/build` do not treat `asset_status = uploaded` alone as sufficient; use **`validated`** until a real validation pipeline exists.
2. **Bucket** — **`project-media`** must exist in the Supabase dashboard; app code does not create it.
3. **Preview engine** — **Not connected** today; placeholder `output_asset_key` will be **replaced by paths matching this preview section** when generation is implemented.
