# 4.11 Developer portal documentation migration

This tool copies **legacy** API Management portal documentation (the `pages` data model and API-scoped pages) into the **next-generation** developer portal structure (`portal_navigation_items` and portal page content), using only the **Management REST API**—no direct database access.

Use it when you move to the next-gen portal and want existing Markdown, OpenAPI/Swagger, folders, and links represented in the new navigation tree.

## Prerequisites

- **Node.js 18+**
- Reachable **APIM Management API** and a **user token** with permission to read legacy pages and create portal navigation items / page contents in the target organization and environment.

## Configuration

1. Use `conf.json` for configuration. The script always reads it from the **same folder as** `migrate-portal-documentation.js` (fixed path in code, not relative to your shell’s current directory).

| Field | Description |
| --- | --- |
| `baseUrl` | Management API base URL (no trailing slash), e.g. `https://apim.example.com` |
| `orgId` | Organization ID |
| `envId` | Environment ID |
| `token` | Bearer token for the Management API |
| `dryRun` | `true`: no writes; only logs and report. `false`: performs migration |
| `reportPath` | Optional. Markdown report path (default: `migration-report.md`, relative to the current working directory unless absolute) |


## Run the migration

```bash
npm run migrate
```

**Recommended:** run once with `"dryRun": true`, review the report and logs, then set `"dryRun": false` and run again.

New navigation entries are created **unpublished** (`published: false`) so you can review them in the developer portal before publishing.


## Resulting structure

**`DOCUMENTATION_MIGRATION`**: — Top-level folder
- **`ENVIRONMENT`** — environment level legacy pages and folders
  - **`HOMEPAGE`** — folder containing the homepage  
  - Other environment documentation pages and folders
- **`APIS`** — one subtree per API (named from the API)  
  - API homepage and all migrated pages/folders for that API, preserving folder hierarchy where applicable

## Report

A **`migration-report.md`** summarizes the run, including dry-run mode, skipped items, and errors—use it as an audit trail for review.

## Idempotency and safety

- If **`DOCUMENTATION_MIGRATION`** already exists at the root of the portal navigation, the script **does not** re-import all legacy pages; it stops early so you can run the command multiple times safely after a successful migration.
- APIs or pages that are already represented in portal navigation (or hit validation errors) are **skipped or logged** so a single failure does not stop the whole run.
- Individual create/update errors are handled **gracefully** (logged, reported); the run continues for other items.


## Limitations

The portal documentation in 4.11 does not support the following content types, they are omitted:

- AsyncAPI, AsciiDoc pages  
- Translations  
- Markdown templates
- **Relative links** in migrated Markdown (or other content) are **not rewritten**. After migration, some in-portal links may need manual fixes.

## Development

To run tests, execute:

```bash
npm test
```
