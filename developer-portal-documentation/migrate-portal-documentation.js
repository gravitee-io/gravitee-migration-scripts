#!/usr/bin/env node
/**
 * Migrate legacy documentation (`pages`) into portal navigation + portal page content
 * using only the APIM Management REST API (no direct DB access).
 *
 * Prerequisites: Node.js 18+ (global fetch).
 *
 * Reads:
 *   - Management API v1: GET .../organizations/{org}/environments/{env}/portal/pages
 *   - Management API v2: GET .../environments/{env}/apis (paginated), GET .../apis/{apiId}/pages
 *
 * Writes:
 *   - Management API v2: POST .../portal-navigation-items (and PUT .../portal-page-contents/{id} for PAGE bodies)
 *
 * Configuration (required): `conf.json` next to this script.
 * Shape: `{ "baseUrl", "orgId", "envId", "token", "dryRun"?, "reportPath"? }`
 *
 * Run: `npm run migrate` or `node migrate-portal-documentation.js` (from this directory).
 *
 * Idempotency:
 *   By default, if the TOP_NAVBAR root folder named DOCUMENTATION_MIGRATION already exists, the script exits
 *   immediately without loading legacy pages or calling create APIs — safe to run multiple times.
 *
 * Resulting tree (TOP_NAVBAR):
 *   DOCUMENTATION_MIGRATION
 *   ├── ENVIRONMENT
 *   │   ├── HOMEPAGE          (environment-scoped legacy pages with homepage=true only)
 *   │   └── …                 (other environment documentation, non-homepage)
 *   └── APIS
 *       ├── My API            (type API — all pages for that API, including API homepage)
 *       └── …
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG = {
  migrationFolderName: 'DOCUMENTATION_MIGRATION',
  environmentFolderName: 'ENVIRONMENT',
  homepageFolderName: 'HOMEPAGE',
  apisFolderName: 'APIS',
  dryRun: false,
  /** Default report path (relative to cwd unless absolute). Overridden in conf.json. */
  reportPath: 'migration-report.md',
};

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MIGRATION_CONFIG_PATH = join(SCRIPT_DIR, 'conf.json');

/**
 * Reads connection/settings JSON. Expected shape:
 * `{ "baseUrl", "orgId", "envId", "token", "dryRun"?, "reportPath"? }`
 * @returns {Record<string, unknown>}
 */
function readConnectionConfigFile(resolvedPath) {
  if (!existsSync(resolvedPath)) {
    console.error(`Config file not found: ${resolvedPath}`);
    process.exit(1);
  }
  let raw;
  try {
    raw = readFileSync(resolvedPath, 'utf8');
  } catch (e) {
    console.error(`Failed to read config file ${resolvedPath}: ${e.message || e}`);
    process.exit(1);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    console.error(`Invalid JSON in config file ${resolvedPath}: ${e.message || e}`);
    process.exit(1);
  }
  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    console.error(`Invalid config file (expected a JSON object): ${resolvedPath}`);
    process.exit(1);
  }
  return data;
}

function loadMigrationConfig() {
  const fileConfig = readConnectionConfigFile(MIGRATION_CONFIG_PATH);

  const baseUrl = typeof fileConfig.baseUrl === 'string' ? fileConfig.baseUrl : '';
  const orgId = typeof fileConfig.orgId === 'string' ? fileConfig.orgId : '';
  const envId = typeof fileConfig.envId === 'string' ? fileConfig.envId : '';
  const token = typeof fileConfig.token === 'string' ? fileConfig.token : '';

  CONFIG.dryRun = fileConfig.dryRun === true;
  CONFIG.reportPath =
    (typeof fileConfig.reportPath === 'string' ? fileConfig.reportPath : '') || CONFIG.reportPath;

  if (!baseUrl || !orgId || !envId || !token) {
    console.error('Missing baseUrl, orgId, envId, or token in conf.json (all are required).');
    process.exit(1);
  }

  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    orgId,
    envId,
    token,
  };
}

function v1Path(cfg, subPath) {
  return `${cfg.baseUrl}/management/organizations/${encodeURIComponent(cfg.orgId)}/environments/${encodeURIComponent(cfg.envId)}${subPath}`;
}

function v2Path(cfg, subPath) {
  return `${cfg.baseUrl}/management/v2/organizations/${encodeURIComponent(cfg.orgId)}/environments/${encodeURIComponent(cfg.envId)}${subPath}`;
}

async function apiFetch(cfg, url, options = {}) {
  const headers = {
    Accept: 'application/json',
    ...options.headers,
  };
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (cfg.token) {
    headers.Authorization = `Bearer ${cfg.token}`;
  }

  const res = await fetch(url, {
    ...options,
    headers,
  });

  const text = await res.text();
  let json;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText}: ${typeof json === 'string' ? json : JSON.stringify(json)}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }

  return json;
}

/**
 * Collects apiId values from portal navigation items of type API (entire TOP_NAVBAR tree).
 */
function collectReferencedApiIdsFromNavItems(items) {
  const ids = new Set();
  if (!Array.isArray(items)) return ids;
  for (const item of items) {
    const t = (item.type || '').toUpperCase();
    if (t === 'API' && item.apiId != null && item.apiId !== '') {
      ids.add(String(item.apiId));
    }
  }
  return ids;
}

/**
 * All TOP_NAVBAR navigation items including nested children (flat list).
 */
async function fetchTopNavbarNavigationItemsWithChildren(cfg) {
  const url = `${v2Path(cfg, '/portal-navigation-items')}?area=TOP_NAVBAR&loadChildren=true`;
  const res = await apiFetch(cfg, url, { method: 'GET' });
  return res.items || [];
}

function getPageId(p) {
  return p?.id ?? null;
}

function pageTitle(p) {
  const t = p.title;
  if (t != null && String(t).trim() !== '') return String(t).trim();
  if (p.name != null && String(p.name).trim() !== '') return String(p.name).trim();
  return 'Untitled';
}

function uniqueAmongSiblings(base, used) {
  let name = base;
  let n = 0;
  while (used.has(name)) {
    n += 1;
    name = `${base} (${n})`;
  }
  used.add(name);
  return name;
}

function isFolderLike(p) {
  const t = (p.type || '').toUpperCase();
  return t === 'FOLDER' || t === 'ROOT' || t === 'SYSTEM_FOLDER';
}

function isLinkType(p) {
  return (p.type || '').toUpperCase() === 'LINK';
}

function looksLikeHttpUrl(s) {
  return /^https?:\/\//i.test((s || '').trim());
}

/**
 * Maps legacy page to nav payload.
 * Types that cannot be represented as portal `GRAVITEE_MARKDOWN` / `OPENAPI` without lossy conversion return `{ kind: 'SKIP', reason }`.
 */
function mapLegacyPageToNavPayload(p) {
  if (isFolderLike(p)) {
    return { kind: 'FOLDER' };
  }
  if (isLinkType(p)) {
    const conf = p.configuration || {};
    const resourceType = conf.resourceType || conf.resource_type || '';
    const content = p.content || '';
    let url = content.trim();
    if (resourceType === 'external' || looksLikeHttpUrl(content)) {
      url = content.trim();
    } else if (resourceType === 'page' || resourceType === 'category') {
      url = `https://invalid.invalid/legacy-link?resourceType=${encodeURIComponent(resourceType)}&ref=${encodeURIComponent(content)}`;
    } else if (!url) {
      url = 'https://invalid.invalid/legacy-empty-link';
    }
    return { kind: 'LINK', url };
  }

  const t = (p.type || 'MARKDOWN').toUpperCase();
  const raw = p.content || '';

  if (t === 'SWAGGER') {
    return { kind: 'PAGE', contentType: 'OPENAPI', content: raw };
  }

  if (t === 'MARKDOWN') {
    return { kind: 'PAGE', contentType: 'GRAVITEE_MARKDOWN', content: raw };
  }

  if (t === 'MARKDOWN_TEMPLATE') {
    return {
      kind: 'SKIP',
      legacyType: t,
      reason:
        'Portal navigation content only supports Gravitee Markdown or OpenAPI; Markdown templates are not migrated (recreate manually if needed).',
    };
  }

  if (t === 'TRANSLATION') {
    return {
      kind: 'SKIP',
      legacyType: t,
      reason:
        'Translation pages are not migrated (recreate localized content in the portal navigation model if needed).',
    };
  }

  if (t === 'ASYNCAPI') {
    return {
      kind: 'SKIP',
      legacyType: t,
      reason:
        'AsyncAPI is not migrated (portal page content supports OpenAPI/Swagger and Gravitee Markdown only; convert or attach manually).',
    };
  }

  if (t === 'ASCIIDOC') {
    return {
      kind: 'SKIP',
      legacyType: t,
      reason:
        'AsciiDoc is not migrated (convert to Markdown or OpenAPI and re-import manually if needed).',
    };
  }

  return {
    kind: 'SKIP',
    legacyType: t,
    reason: `Legacy type "${t}" is not migrated (unsupported for automatic portal navigation migration).`,
  };
}

async function fetchEnvPortalPages(cfg) {
  const url = v1Path(cfg, '/portal/pages');
  return apiFetch(cfg, url, { method: 'GET' });
}

async function fetchAllApis(cfg) {
  const out = [];
  let page = 1;
  const perPage = 100;
  for (;;) {
    const url = `${v2Path(cfg, `/apis?page=${page}&perPage=${perPage}`)}`;
    const res = await apiFetch(cfg, url, { method: 'GET' });
    const data = res.data || [];
    out.push(...data);
    const pageCount = res.pagination?.pageCount ?? 1;
    if (page >= pageCount) break;
    page += 1;
    if (data.length === 0) break;
  }
  return out;
}

async function fetchApiPages(cfg, apiId) {
  const url = v2Path(cfg, `/apis/${encodeURIComponent(apiId)}/pages`);
  const res = await apiFetch(cfg, url, { method: 'GET' });
  return res.pages || [];
}

async function fetchApiPageDetail(cfg, apiId, pageId) {
  const url = v2Path(cfg, `/apis/${encodeURIComponent(apiId)}/pages/${encodeURIComponent(pageId)}`);
  return apiFetch(cfg, url, { method: 'GET' });
}

async function fetchEnvPortalPageDetail(cfg, pageId) {
  const url = v1Path(cfg, `/portal/pages/${encodeURIComponent(pageId)}`);
  return apiFetch(cfg, url, { method: 'GET' });
}

/**
 * Root TOP_NAVBAR items only (loadChildren=false).
 */
async function fetchRootNavbarItems(cfg) {
  const url = `${v2Path(cfg, '/portal-navigation-items')}?area=TOP_NAVBAR&loadChildren=false`;
  const res = await apiFetch(cfg, url, { method: 'GET' });
  return res.items || [];
}

async function migrationFolderExists(cfg, title) {
  const roots = await fetchRootNavbarItems(cfg);
  return roots.some((i) => i.parentId == null && i.title === title);
}

function nextRootOrder(roots) {
  let max = -1;
  for (const r of roots) {
    const o = r.order;
    if (typeof o === 'number' && o > max) max = o;
  }
  return max + 1;
}

function apiDisplayName(apiId, apis) {
  if (!apiId) return '';
  const api = apis.find((x) => x.id === apiId);
  return pageTitle(api || { name: apiId });
}

function createReport(cfg) {
  return {
    status: 'completed',
    generatedAt: new Date().toISOString(),
    baseUrl: cfg.baseUrl,
    organizationId: cfg.orgId,
    environmentId: cfg.envId,
    dryRun: CONFIG.dryRun,
    migrated: [],
    skipped: [],
    structure: [],
  };
}

function recordStructure(report, entry) {
  report.structure.push({ ...entry, at: new Date().toISOString() });
}

function recordMigratedPage(report, entry) {
  report.migrated.push({ category: 'legacy_page', ...entry, at: new Date().toISOString() });
}

function recordSkippedPage(report, entry) {
  report.skipped.push({ ...entry, at: new Date().toISOString() });
}

function escapeMdCell(s) {
  if (s == null) return '';
  return String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function formatMigrationReportMarkdown(report) {
  const lines = [];
  lines.push('# Portal navigation migration report');
  lines.push('');
  if (report.status === 'skipped_already_migrated') {
    lines.push('> ## Already migrated — nothing to do');
    lines.push('>');
    lines.push(
      '> **This run did not load legacy pages or change portal navigation.** The migration root folder already exists for this environment (idempotent no-op).',
    );
    lines.push('>');
    lines.push(
      '> To run a full migration again, delete that folder in the Console first.',
    );
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  if (report.dryRun) {
    lines.push('> ## ⚠️ DRY RUN — NO CHANGES APPLIED');
    lines.push('>');
    lines.push('> **This run did not modify the platform.** No portal navigation items were created, updated, or deleted, and no portal page content was written.');
    lines.push('>');
    lines.push('> The sections below describe **what would have happened**. To perform the migration for real, set **`"dryRun": false`** in `conf.json` (next to this script) and run again.');
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  lines.push(`- **Generated:** ${report.generatedAt}`);
  lines.push(`- **Status:** ${report.status}`);
  lines.push(`- **Management API base URL:** ${report.baseUrl}`);
  lines.push(`- **Organization:** ${escapeMdCell(report.organizationId)}`);
  lines.push(`- **Environment:** ${escapeMdCell(report.environmentId)}`);
  lines.push(`- **Dry run:** ${report.dryRun ? 'yes' : 'no'}`);
  if (report.abortReason) {
    lines.push(`- **Note:** ${escapeMdCell(report.abortReason)}`);
  }
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  const structCount = report.structure?.length ?? 0;
  const migratedCount = report.migrated?.length ?? 0;
  const skippedCount = report.skipped?.length ?? 0;
  lines.push(`| Metric | Count |`);
  lines.push(`| --- | ---: |`);
  lines.push(`| Navigation structure items created (folders / API nodes) | ${structCount} |`);
  lines.push(`| Legacy pages / links migrated | ${migratedCount} |`);
  lines.push(`| Legacy pages skipped | ${skippedCount} |`);
  lines.push('');

  if (report.structure?.length) {
    lines.push('## Structure created');
    lines.push('');
    lines.push(`| Role | Title |`);
    lines.push(`| --- | --- |`);
    for (const s of report.structure) {
      lines.push(`| ${escapeMdCell(s.role)} | ${escapeMdCell(s.title)} |`);
    }
    lines.push('');
  }

  lines.push('## Migrated legacy content');
  lines.push('');
  lines.push(
    'Items migrated into portal navigation (folders, links, Markdown pages, Swagger/OpenAPI pages). Content is copied as-is for Markdown and OpenAPI without lossy conversion.',
  );
  lines.push('');
  if (!report.migrated.length) {
    lines.push('*No legacy pages or links were migrated.*');
    lines.push('');
  } else {
    lines.push(`| Scope | API | Legacy page ID | Title | Legacy type | Result |`);
    lines.push(`| --- | --- | --- | --- | --- | --- |`);
    for (const m of report.migrated) {
      const scope = m.scope === 'API' ? 'API' : 'Environment';
      const api = m.scope === 'API' ? escapeMdCell(m.apiName || m.apiId || '') : '—';
      lines.push(
        `| ${scope} | ${api} | ${escapeMdCell(m.legacyPageId)} | ${escapeMdCell(m.title)} | ${escapeMdCell(m.legacyType)} | ${escapeMdCell(m.result)} |`,
      );
    }
    lines.push('');
  }

  lines.push('## Skipped content');
  lines.push('');
  lines.push(
    'These pages were **not** migrated. They remain in the legacy `pages` store only; handle them manually (convert format or recreate in portal navigation).',
  );
  lines.push('');
  if (!report.skipped.length) {
    lines.push('*No pages were skipped.*');
    lines.push('');
  } else {
    lines.push(`| Scope | API | Legacy page ID | Title | Legacy type | Reason |`);
    lines.push(`| --- | --- | --- | --- | --- | --- |`);
    for (const s of report.skipped) {
      const scope = s.scope === 'API' ? 'API' : 'Environment';
      const api = s.scope === 'API' ? escapeMdCell(s.apiName || s.apiId || '') : '—';
      lines.push(
        `| ${scope} | ${api} | ${escapeMdCell(s.legacyPageId)} | ${escapeMdCell(s.title)} | ${escapeMdCell(s.legacyType)} | ${escapeMdCell(s.reason)} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

function writeMigrationReportFile(report, reportPath) {
  const abs = resolve(reportPath);
  const md = formatMigrationReportMarkdown(report);
  writeFileSync(abs, md, 'utf8');
  return abs;
}

/**
 * Clear console message when migration root already exists (idempotent no-op).
 */
function printIdempotentSkipMessage(folderName, reportPath) {
  const sep = '='.repeat(76);
  console.log('');
  console.log(sep);
  console.log('Portal navigation migration — skipped (already applied)');
  console.log(sep);
  console.log(
    `The TOP_NAVBAR root folder "${folderName}" already exists for this environment.`,
  );
  console.log('No legacy documentation was read and no portal navigation items were created or updated.');
  console.log('');
  console.log(`A short report was written to: ${reportPath}`);
  console.log('');
  console.log('To force another migration pass, remove the folder in the Management Console.');
  console.log(sep);
  console.log('');
}

/**
 * Shown after a full migration run finishes (real or dry run).
 */
function printMigrationSuccessMessage(report, reportPath) {
  const sep = '='.repeat(76);
  const struct = report.structure?.length ?? 0;
  const migrated = report.migrated?.length ?? 0;
  const skipped = report.skipped?.length ?? 0;

  console.log('');
  console.log(sep);
  if (report.dryRun) {
    console.log('Portal navigation migration — dry run finished');
    console.log(sep);
    console.log('No changes were sent to the API. Lines marked [dry-run] show what would be created.');
  } else {
    console.log('Portal navigation migration — completed successfully');
    console.log(sep);
    console.log('Legacy documentation was imported into portal navigation under the new folder tree.');
  }
  console.log('');
  console.log(`  Organization     ${report.organizationId}`);
  console.log(`  Environment      ${report.environmentId}`);
  console.log('');
  console.log('  Totals');
  console.log(`    Structure items (folders, API entries, …)     ${struct}`);
  console.log(`    Legacy items migrated (pages, links, folders)   ${migrated}`);
  console.log(`    Legacy pages skipped (unsupported types)      ${skipped}`);
  console.log('');
  console.log(`  Report file      ${reportPath}`);
  console.log('');
  if (report.dryRun) {
    console.log('  To apply for real: set "dryRun": false in conf.json and run again.');
  } else {
    console.log("  What's next: open the Management Console > Next Gen Portal Settings,");
    console.log('               publish items when you are ready, and check the developer portal.');
    console.log('               Re-running this script will exit immediately (idempotent) until you');
    console.log('               remove the root folder DOCUMENTATION_MIGRATION.');
  }
  console.log(sep);
  console.log('');
}

/**
 * No legacy pages returned from the API.
 */
function printNoPagesMessage(reportPath) {
  const sep = '='.repeat(76);
  console.log('');
  console.log(sep);
  console.log('Portal navigation migration — nothing to do');
  console.log(sep);
  console.log('No legacy documentation pages were returned for this organization / environment.');
  console.log('There is nothing to migrate into portal navigation.');
  console.log('');
  console.log(`  Report file      ${reportPath}`);
  console.log(sep);
  console.log('');
}

async function createPortalNavigationItem(cfg, body) {
  if (CONFIG.dryRun) {
    console.log('[dry-run] POST portal-navigation-items', JSON.stringify(body, null, 0));
    return { ...body, id: body.id || randomUUID(), portalPageContentId: body.portalPageContentId || randomUUID() };
  }
  const url = v2Path(cfg, '/portal-navigation-items');
  return apiFetch(cfg, url, { method: 'POST', body: JSON.stringify(body) });
}

async function updatePortalPageContent(cfg, portalPageContentId, content) {
  if (CONFIG.dryRun) {
    console.log('[dry-run] PUT portal-page-contents', portalPageContentId, `(content length ${content?.length ?? 0})`);
    return;
  }
  const url = v2Path(cfg, `/portal-page-contents/${encodeURIComponent(portalPageContentId)}`);
  await apiFetch(cfg, url, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  });
}

/**
 * Ensure PAGE has body (list endpoints may omit large content).
 */
async function ensurePageContent(cfg, page, scope, apiId) {
  const payload = mapLegacyPageToNavPayload(page);
  if (payload.kind === 'SKIP') return page;
  if (payload.kind !== 'PAGE') return page;
  if (page.content != null && String(page.content).length > 0) return page;
  try {
    if (scope === 'ENVIRONMENT') {
      return await fetchEnvPortalPageDetail(cfg, page.id);
    }
    if (scope === 'API' && apiId) {
      return await fetchApiPageDetail(cfg, apiId, page.id);
    }
  } catch (e) {
    console.warn(`Could not load content for page ${page.id}:`, e.message || e);
  }
  return page;
}

/**
 * Indirection for side-effectful calls (HTTP / content).
 * Tests replace individual methods via `mock.method(io, 'createNavItem', ...)`.
 */
const io = {
  createNavItem: createPortalNavigationItem,
  updateContent: updatePortalPageContent,
  loadContent: ensurePageContent,
};

/**
 * Recursively create nav items (folders recurse; pages and links do not), mirroring migrateSubtreeSimple in the mongosh script.
 * @param {Set<string>} [initialSiblingTitles] — titles already taken at the first level under `parentNavId` (e.g. HOMEPAGE folder).
 */
async function migrateSubtreeFlat(cfg, pages, subsetIds, parentNavId, orderOffset, fetchContent, initialSiblingTitles, report, apis) {
  function normalizeParentId(page) {
    const pid = page.parentId;
    if (!pid || !subsetIds.has(pid)) return null;
    return pid;
  }

  async function walk(parentPageId, parentNavIdLocal, titleUsedAtLevel, ordStart) {
    const children = pages
      .filter((pp) => subsetIds.has(getPageId(pp)) && normalizeParentId(pp) === parentPageId)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    const used = titleUsedAtLevel;
    let ord = ordStart;

    for (const p of children) {
      const title = uniqueAmongSiblings(pageTitle(p), used);
      const legacyType = (p.type || 'MARKDOWN').toUpperCase();
      const scope = p._scope;
      const apiId = p._apiId || null;
      const apiName = scope === 'API' ? apiDisplayName(apiId, apis) : null;

      try {
        const fullPage = fetchContent ? await io.loadContent(cfg, p, p._scope, p._apiId) : p;
        const payload = mapLegacyPageToNavPayload(fullPage);

        if (payload.kind === 'SKIP') {
          recordSkippedPage(report, {
            legacyPageId: getPageId(p),
            title,
            legacyType: payload.legacyType || legacyType,
            scope,
            apiId,
            apiName,
            reason: payload.reason,
          });
          continue;
        }

        if (payload.kind === 'FOLDER') {
          const body = {
            type: 'FOLDER',
            title,
            area: 'TOP_NAVBAR',
            parentId: parentNavIdLocal,
            visibility: 'PRIVATE',
            published: false,
            order: ord,
          };
          const created = await io.createNavItem(cfg, body);
          ord += 1;
          recordMigratedPage(report, {
            legacyPageId: getPageId(p),
            title,
            legacyType,
            scope,
            apiId,
            apiName,
            result: 'Folder created under portal navigation',
          });
          await walk(getPageId(p), created.id, new Set(), 0);
        } else if (payload.kind === 'LINK') {
          const body = {
            type: 'LINK',
            title,
            area: 'TOP_NAVBAR',
            parentId: parentNavIdLocal,
            url: payload.url,
            visibility: 'PRIVATE',
            published: false,
            order: ord,
          };
          await io.createNavItem(cfg, body);
          ord += 1;
          recordMigratedPage(report, {
            legacyPageId: getPageId(p),
            title,
            legacyType,
            scope,
            apiId,
            apiName,
            result: 'External / legacy link created in portal navigation',
          });
        } else {
          const body = {
            type: 'PAGE',
            title,
            area: 'TOP_NAVBAR',
            parentId: parentNavIdLocal,
            visibility: 'PRIVATE',
            published: false,
            order: ord,
            contentType: payload.contentType,
          };
          const created = await io.createNavItem(cfg, body);
          const contentId = created.portalPageContentId;
          if (!contentId) {
            throw new Error(`PAGE created without portalPageContentId for ${title}`);
          }
          await io.updateContent(cfg, contentId, payload.content);
          ord += 1;
          const result =
            payload.contentType === 'OPENAPI'
              ? 'OpenAPI / Swagger body stored in portal page content'
              : 'Markdown body copied as-is into portal page content';
          recordMigratedPage(report, {
            legacyPageId: getPageId(p),
            title,
            legacyType,
            scope,
            apiId,
            apiName,
            result,
          });
        }
      } catch (err) {
        console.warn(`[error] Page "${title}" (${getPageId(p)}): ${err.message || err}`);
        recordSkippedPage(report, {
          legacyPageId: getPageId(p),
          title,
          legacyType,
          scope,
          apiId,
          apiName,
          reason: `Migration failed: ${err.message || err}`,
        });
      }
    }
  }

  const rootTitles = initialSiblingTitles ? new Set(initialSiblingTitles) : new Set();
  await walk(null, parentNavId, rootTitles, orderOffset);
}

async function run() {
  const cfg = loadMigrationConfig();
  const report = createReport(cfg);

  console.log(`Base URL: ${cfg.baseUrl}, org=${cfg.orgId}, env=${cfg.envId}, dryRun=${CONFIG.dryRun}`);

  if (await migrationFolderExists(cfg, CONFIG.migrationFolderName)) {
    report.status = 'skipped_already_migrated';
    report.abortReason = `TOP_NAVBAR folder "${CONFIG.migrationFolderName}" already exists — migration not re-run (idempotent).`;
    const out = writeMigrationReportFile(report, CONFIG.reportPath);
    printIdempotentSkipMessage(CONFIG.migrationFolderName, out);
    return;
  }

  console.log('Fetching environment portal pages...');
  const envPortalPages = await fetchEnvPortalPages(cfg);
  const envPages = Array.isArray(envPortalPages) ? envPortalPages : [];
  const envTagged = envPages.map((p) => ({ ...p, _scope: 'ENVIRONMENT', _apiId: null }));
  console.log(`  Found ${envPages.length} environment page(s).`);

  console.log('Fetching APIs...');
  const apis = await fetchAllApis(cfg);
  console.log(`  Found ${apis.length} API(s). Loading documentation pages...`);
  const apiTagged = [];
  for (let i = 0; i < apis.length; i++) {
    const api = apis[i];
    const apiId = api.id;
    if (!apiId) continue;
    if (apis.length > 10 && (i + 1) % 10 === 0) {
      console.log(`  Loading pages for API ${i + 1}/${apis.length}...`);
    }
    const pages = await fetchApiPages(cfg, apiId);
    for (const p of pages) {
      apiTagged.push({ ...p, _scope: 'API', _apiId: apiId });
    }
  }
  console.log(`  Loaded ${apiTagged.length} API page(s) across ${apis.length} API(s).`);

  const allPages = [...envTagged, ...apiTagged];
  if (allPages.length === 0) {
    report.status = 'aborted_no_pages';
    report.abortReason = 'No legacy pages returned by the Management API.';
    const out = writeMigrationReportFile(report, CONFIG.reportPath);
    printNoPagesMessage(out);
    return;
  }

  const roots = await fetchRootNavbarItems(cfg);
  const migrationRootOrder = nextRootOrder(roots);

  const body = {
    type: 'FOLDER',
    title: CONFIG.migrationFolderName,
    area: 'TOP_NAVBAR',
    visibility: 'PRIVATE',
    published: false,
    order: migrationRootOrder,
  };
  const migrationRoot = await io.createNavItem(cfg, body);
  const migrationId = migrationRoot.id;
  recordStructure(report, { role: 'Root migration folder', title: CONFIG.migrationFolderName });

  const hasEnvDocs = envTagged.length > 0;
  const hasApiDocs = apiTagged.length > 0;

  /** Environment-only homepages (legacy “portal homepage” pages — not API homepages). */
  const envHomePages = envTagged.filter((p) => p.homepage === true);
  const nonHomeEnvPages = envTagged.filter((p) => p.homepage !== true);

  const envHomeIds = new Set(envHomePages.map(getPageId));
  const envNonHomeIds = new Set(nonHomeEnvPages.map(getPageId));

  /** All page ids per API, including homepage pages (stay under that API’s nav item). */
  const apiPagesByApiId = new Map();
  for (const p of apiTagged) {
    const aid = p._apiId;
    if (!apiPagesByApiId.has(aid)) apiPagesByApiId.set(aid, new Set());
    apiPagesByApiId.get(aid).add(getPageId(p));
  }

  let migrationChildOrder = 0;
  const migrationTitleUsed = new Set();

  if (hasEnvDocs) {
    console.log(`Migrating ${envTagged.length} environment page(s)...`);
    const envFolder = await io.createNavItem(cfg, {
      type: 'FOLDER',
      title: uniqueAmongSiblings(CONFIG.environmentFolderName, migrationTitleUsed),
      area: 'TOP_NAVBAR',
      parentId: migrationId,
      visibility: 'PRIVATE',
      published: false,
      order: migrationChildOrder,
    });
    migrationChildOrder += 1;
    const environmentFolderId = envFolder.id;
    recordStructure(report, { role: 'Environment documentation folder', title: CONFIG.environmentFolderName });

    let envInnerOrder = 0;
    const envSiblingTitles = new Set();

    if (envHomePages.length > 0) {
      const hpTitle = uniqueAmongSiblings(CONFIG.homepageFolderName, envSiblingTitles);
      const hpFolder = await io.createNavItem(cfg, {
        type: 'FOLDER',
        title: hpTitle,
        area: 'TOP_NAVBAR',
        parentId: environmentFolderId,
        visibility: 'PRIVATE',
        published: false,
        order: envInnerOrder,
      });
      envInnerOrder += 1;
      recordStructure(report, { role: 'Environment homepages folder', title: hpTitle });
      await migrateSubtreeFlat(cfg, envHomePages, envHomeIds, hpFolder.id, 0, true, undefined, report, apis);
    }

    if (nonHomeEnvPages.length > 0) {
      await migrateSubtreeFlat(cfg, nonHomeEnvPages, envNonHomeIds, environmentFolderId, envInnerOrder, true, envSiblingTitles, report, apis);
    }
  }

  if (hasApiDocs) {
    const existingApiIdsInNav = collectReferencedApiIdsFromNavItems(await fetchTopNavbarNavigationItemsWithChildren(cfg));

    const apisFolder = await io.createNavItem(cfg, {
      type: 'FOLDER',
      title: uniqueAmongSiblings(CONFIG.apisFolderName, migrationTitleUsed),
      area: 'TOP_NAVBAR',
      parentId: migrationId,
      visibility: 'PRIVATE',
      published: false,
      order: migrationChildOrder,
    });
    migrationChildOrder += 1;
    const apisFolderId = apisFolder.id;
    recordStructure(report, { role: 'APIs container folder', title: CONFIG.apisFolderName });

    const apiTitleUsed = new Set();
    const apiIdsToMigrate = [...apiPagesByApiId.keys()].sort((a, b) => {
      const apiA = apis.find((x) => x.id === a);
      const apiB = apis.find((x) => x.id === b);
      return pageTitle(apiA || { name: a }).localeCompare(pageTitle(apiB || { name: b }));
    });

    const totalApis = apiIdsToMigrate.length;
    console.log(`Migrating documentation for ${totalApis} API(s)...`);

    let apiSiblingOrder = 0;
    for (let apiIdx = 0; apiIdx < totalApis; apiIdx++) {
      const apiId = apiIdsToMigrate[apiIdx];
      const subsetIds = apiPagesByApiId.get(apiId);
      const api = apis.find((x) => x.id === apiId);
      const apiTitleStr = uniqueAmongSiblings(pageTitle(api || { name: apiId }), apiTitleUsed);
      const pagesForApi = allPages.filter((p) => subsetIds.has(getPageId(p)));
      const apiNameForReport = apiDisplayName(apiId, apis);

      console.log(`  [${apiIdx + 1}/${totalApis}] ${apiTitleStr} (${pagesForApi.length} page(s))`);

      if (existingApiIdsInNav.has(apiId)) {
        console.warn(
          `[skip] API "${apiTitleStr}" (${apiId}): a portal navigation item for this apiId already exists — legacy docs for this API were not copied.`,
        );
        for (const p of pagesForApi) {
          recordSkippedPage(report, {
            legacyPageId: getPageId(p),
            title: pageTitle(p),
            legacyType: (p.type || 'MARKDOWN').toUpperCase(),
            scope: 'API',
            apiId,
            apiName: apiNameForReport,
            reason:
              'A portal navigation item referencing this apiId already exists. Each API may appear at most once in navigation. Remove or relocate that entry in the Console, then re-run if needed.',
          });
        }
        continue;
      }

      try {
        const apiNav = await io.createNavItem(cfg, {
          type: 'API',
          title: apiTitleStr,
          area: 'TOP_NAVBAR',
          parentId: apisFolderId,
          apiId,
          visibility: 'PRIVATE',
          published: false,
          order: apiSiblingOrder,
        });
        existingApiIdsInNav.add(apiId);

        apiSiblingOrder += 1;

        recordStructure(report, {
          role: 'API navigation entry',
          title: `${apiTitleStr} (${apiId})`,
        });

        await migrateSubtreeFlat(cfg, pagesForApi, subsetIds, apiNav.id, 0, true, undefined, report, apis);
      } catch (err) {
        console.warn(`[error] API "${apiTitleStr}" (${apiId}): ${err.message || err}`);
        for (const p of pagesForApi) {
          recordSkippedPage(report, {
            legacyPageId: getPageId(p),
            title: pageTitle(p),
            legacyType: (p.type || 'MARKDOWN').toUpperCase(),
            scope: 'API',
            apiId,
            apiName: apiNameForReport,
            reason: `API migration failed: ${err.message || err}`,
          });
        }
      }
    }
  }

  const reportOut = writeMigrationReportFile(report, CONFIG.reportPath);
  printMigrationSuccessMessage(report, reportOut);
}

/** True when this file is the process entrypoint (not when imported by tests). */
const isMainModule =
  process.argv[1] != null && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

export {
  apiDisplayName,
  collectReferencedApiIdsFromNavItems,
  createReport,
  escapeMdCell,
  formatMigrationReportMarkdown,
  getPageId,
  io,
  isFolderLike,
  isLinkType,
  looksLikeHttpUrl,
  mapLegacyPageToNavPayload,
  migrateSubtreeFlat,
  nextRootOrder,
  pageTitle,
  uniqueAmongSiblings,
  v1Path,
  v2Path,
};

if (isMainModule) {
  run().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
