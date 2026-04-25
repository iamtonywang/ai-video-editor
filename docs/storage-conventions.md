# Supabase Storage — reference assets (phase 1)

This document fixes **bucket name**, **object path layout**, and how values map to **`source_assets`** via `POST /api/source/register`.  
**No upload implementation lives in the repo yet**; this is the contract for when it is added.

## Bucket (dashboard setup)

| Item | Value |
|--------|--------|
| **Bucket name** | `project-media` |

Create the **`project-media`** bucket in the Supabase project dashboard (Storage). Policies/RLS are not defined in this repo—configure them when implementing upload.

## Phase 1 upload target

- **Asset role in Storage**: reference material for identity / gate flows.
- **`source_assets.asset_type`** when registering: **`reference`** (only this type for phase 1 uploads).

## Object path rule

Objects are stored **under** bucket `project-media` with this path pattern:

```text
projects/{projectId}/references/{uuid}.{ext}
```

Where:

- **`{projectId}`** — Project UUID (same as `projects.id` / URL segment).
- **`{uuid}`** — A new UUID (e.g. `crypto.randomUUID()`). **Do not use the original filename in the path**; the basename is UUID-based to avoid collisions, unsafe characters, and overlong paths.
- **`{ext}`** — Normalized extension only (e.g. `png`, `jpg`, `webp`), derived from MIME or a safe allowlist—not the raw client filename string.

**Example object key inside the bucket:**

```text
projects/a1b2c3d4-e5f6-7890-abcd-ef1234567890/references/f47ac10b-58cc-4372-a567-0e02b2c3d479.png
```

## `asset_key` for `POST /api/source/register`

Store **`asset_key` as the object path only** — **without** bucket name or leading slash:

- **Correct:** `projects/{projectId}/references/{uuid}.png`
- **Incorrect:** `project-media/projects/...` (bucket must not be part of `asset_key`)
- **Incorrect:** `/projects/...` (no leading slash)

Example for `POST /api/source/register` JSON body:

```json
{
  "project_id": "<uuid>",
  "asset_type": "reference",
  "asset_key": "projects/a1b2c3d4-e5f6-7890-abcd-ef1234567890/references/f47ac10b-58cc-4372-a567-0e02b2c3d479.png",
  "asset_status": "validated"
}
```

## After upload — registration rule

After a successful Storage upload to `project-media` at the path above, call **`/api/source/register`** with:

| Field | Value |
|--------|--------|
| `asset_type` | `reference` |
| `asset_status` | `validated` |

This matches the current UI and keeps **`execution-context`** / **`identity/build`** queries satisfied (they require `asset_status` in `validated` / `active` or `validation_status` validated — **`uploaded` alone does not pass**).

## Caveats (read before implementing upload)

1. **`uploaded` only** — Current **`execution-context`** and **`identity/build`** logic **do not** treat `asset_status = uploaded` as sufficient. Do not register with only `uploaded` unless those APIs are changed later.
2. **`validated` as interim** — Until a real validation pipeline exists, **`validated` is used pragmatically** after upload succeeds (integrity/MIME checks can be added later without changing the path contract).
3. **Bucket creation** — The **`project-media`** bucket is **not** created by application code; it must exist in Supabase before uploads work.
4. **Code** — This document does not change runtime behavior; implementors must align upload + register with these rules.
