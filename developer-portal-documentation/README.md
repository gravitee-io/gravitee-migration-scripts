# 4.11 Developer portal documentation migration

This tool copies legacy API Management portal documentation (the `pages` data model and API-scoped pages) into the next-generation developer portal structure (`portal_navigation_items` and portal page content), using only the **Management REST API** (no direct database access).

Use it when you move to the 4.11 version of the next-gen portal and want existing Markdown, OpenAPI/Swagger, folders, and links represented in the new navigation tree.

## Prerequisites

- **Node.js 18+**
- Reachable **APIM Management API** and a **user Bearer JWT token** with permissions to read legacy pages and create portal navigation items / page contents in the target organization and environment.

## Configuration

Use `conf.json` for configuration:


| Field        | Description                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `baseUrl`    | Management API base URL (no trailing slash), e.g. `https://apim.example.com`                                               |
| `orgId`      | Organization ID                                                                                                            |
| `envId`      | Environment ID                                                                                                             |
| `token`      | Bearer token for the Management API                                                                                        |
| `dryRun`     | `true`: no writes; only logs and report. `false`: performs migration                                                       |
| `reportPath` | Optional. Markdown report path (default: `migration-report.md`, relative to the current working directory unless absolute) |

### Finding the Management API base URL

`baseUrl` is the **origin** of the Management API, which can be retrieved via Developer Tools in the browser:

1. Sign in to the **Gravitee Console**.
2. Open **Developer Tools** → **Network**, then perform an action in the Console that triggers a Management API call (e.g. click on any menu item).
3. Select a request whose URL contains `/management/` (e.g. https://apim.example.com/management/...), and copy only the origin `https://apim.example.com` (protocol + host + port), and paste it in `conf.json`.

### Finding the JWT token

You must supply a `token` that belongs to a user with permissions to read legacy pages and create portal navigation items / page contents in the target organization and environment. You can retrieve the token in a few ways.

#### Token from an authenticated browser session

1. Sign in to the **Gravitee Console** in the browser using a login / password pair or via SSO.
2. Open **Developer Tools** → **Network**, make any action inside the **Gravitee Console** to trigger a Management API request, and copy the value of `Auth-Graviteeio-APIM=Bearer <VALUE>` from the request headers.

#### Token from the Rest API

If your environment uses an identity provider that allows basic authentication with login and password, you can get a JWT by calling the login endpoint:

```bash
curl -sS -u '<USER>:<PASSWORD>' \
  -X POST '<GRAVITEE_BASE_URL>/management/organizations/<ORG_ID>/user/login' \
  -H 'Content-Type: application/json'
```

The response body includes a Bearer token you can use for the migration.


## Run the migration

Once you have retrieved the token and filled in all the values in `conf.json`, use the following command to run the script.

**Recommended:** run once with `"dryRun": true`, review the report and logs, then set `"dryRun": false` and run again.

```bash
npm run migrate
```

New navigation items are **unpublished** and **private** so you can review them in the developer portal settings before publishing.

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

- If **`DOCUMENTATION_MIGRATION`** folder already exists at the root of the portal navigation, the script **does not** re-import all legacy pages; it stops early so you can run the command multiple times safely after a successful migration.
- APIs or pages that are already represented in portal navigation (or hit validation errors) are **skipped or logged** so a single failure does not stop the whole run.
- Individual create/update errors are handled **gracefully** (logged, reported); the run continues for other items.

## Limitations

The portal documentation in 4.11 does not support the following content types, they are omitted:

- AsyncAPI, AsciiDoc pages  
- Translations  
- Markdown templates
- **Relative links** in migrated Markdown (or other content) are **not rewritten**. After migration, some in-portal links may need manual fixes.

## Development

To run script tests, execute:

```bash
npm test
```

