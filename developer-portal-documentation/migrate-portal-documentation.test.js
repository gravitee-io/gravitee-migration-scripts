/*
 * Copyright © 2015 The Gravitee team (http://gravitee.io)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Unit tests for migrate-portal-documentation.js (pure helpers).
 *
 * Run: npm test  (from developer-portal-documentation/)
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import {
  apiDisplayName,
  apiOwnedWriter,
  checkTargetVersionAgainstServer,
  collectReferencedApiIdsFromNavItems,
  createReport,
  ensurePageContent,
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
  parseTargetApimVersion,
  runMigration,
  uniqueAmongSiblings,
  v1Path,
  v2Path,
  writerFor,
} from './migrate-portal-documentation.js';

const sampleCfg = {
  baseUrl: 'https://apim.example.com',
  orgId: 'DEFAULT',
  envId: 'DEFAULT',
  token: 'x',
};

describe('v1Path / v2Path', () => {
  it('builds v1 portal pages URL with encoded ids', () => {
    assert.equal(
      v1Path(sampleCfg, '/portal/pages'),
      'https://apim.example.com/management/organizations/DEFAULT/environments/DEFAULT/portal/pages',
    );
  });

  it('encodes special characters in org and env', () => {
    const cfg = { ...sampleCfg, orgId: 'O/RG', envId: 'E:N' };
    assert.ok(v1Path(cfg, '/portal/pages').includes('O%2FRG'));
    assert.ok(v1Path(cfg, '/portal/pages').includes('E%3AN'));
  });

  it('builds v2 navigation URL', () => {
    assert.equal(
      v2Path(sampleCfg, '/portal-navigation-items'),
      'https://apim.example.com/management/v2/organizations/DEFAULT/environments/DEFAULT/portal-navigation-items',
    );
  });
});

describe('pageTitle', () => {
  it('prefers title over name', () => {
    assert.equal(pageTitle({ title: ' T ', name: 'N' }), 'T');
  });

  it('falls back to name', () => {
    assert.equal(pageTitle({ name: 'Only' }), 'Only');
  });

  it('returns Untitled when empty', () => {
    assert.equal(pageTitle({}), 'Untitled');
  });
});

describe('uniqueAmongSiblings', () => {
  it('deduplicates titles', () => {
    const used = new Set();
    assert.equal(uniqueAmongSiblings('Doc', used), 'Doc');
    assert.equal(uniqueAmongSiblings('Doc', used), 'Doc (1)');
    assert.equal(uniqueAmongSiblings('Doc', used), 'Doc (2)');
  });
});

describe('getPageId', () => {
  it('returns id when present', () => {
    assert.equal(getPageId({ id: 'p1' }), 'p1');
  });

  it('returns null when missing', () => {
    assert.equal(getPageId({}), null);
  });
});

describe('isFolderLike / isLinkType', () => {
  it('detects folder-like types', () => {
    assert.equal(isFolderLike({ type: 'FOLDER' }), true);
    assert.equal(isFolderLike({ type: 'ROOT' }), true);
    assert.equal(isFolderLike({ type: 'SYSTEM_FOLDER' }), true);
    assert.equal(isFolderLike({ type: 'MARKDOWN' }), false);
  });

  it('detects LINK', () => {
    assert.equal(isLinkType({ type: 'LINK' }), true);
    assert.equal(isLinkType({ type: 'link' }), true);
  });
});

describe('looksLikeHttpUrl', () => {
  it('matches http(s) URLs', () => {
    assert.equal(looksLikeHttpUrl('https://a.b'), true);
    assert.equal(looksLikeHttpUrl('http://x'), true);
  });

  it('rejects non-URLs', () => {
    assert.equal(looksLikeHttpUrl('ftp://x'), false);
    assert.equal(looksLikeHttpUrl(''), false);
  });
});

describe('mapLegacyPageToNavPayload', () => {
  it('maps FOLDER', () => {
    assert.deepEqual(mapLegacyPageToNavPayload({ type: 'FOLDER' }), { kind: 'FOLDER' });
  });

  it('maps external LINK from content', () => {
    const r = mapLegacyPageToNavPayload({
      type: 'LINK',
      content: 'https://docs.example.com',
      configuration: {},
    });
    assert.equal(r.kind, 'LINK');
    assert.equal(r.url, 'https://docs.example.com');
  });

  it('maps LINK with resourceType page to placeholder URL', () => {
    const r = mapLegacyPageToNavPayload({
      type: 'LINK',
      content: 'some-ref',
      configuration: { resourceType: 'page' },
    });
    assert.equal(r.kind, 'LINK');
    assert.ok(r.url.includes('invalid.invalid'));
    assert.ok(r.url.includes('resourceType=page'));
  });

  it('maps MARKDOWN to GRAVITEE_MARKDOWN', () => {
    const r = mapLegacyPageToNavPayload({ type: 'MARKDOWN', content: '# Hi' });
    assert.equal(r.kind, 'PAGE');
    assert.equal(r.contentType, 'GRAVITEE_MARKDOWN');
    assert.equal(r.content, '# Hi');
  });

  it('maps SWAGGER to OPENAPI', () => {
    const r = mapLegacyPageToNavPayload({ type: 'SWAGGER', content: '{"openapi":"3.0.0"}' });
    assert.equal(r.kind, 'PAGE');
    assert.equal(r.contentType, 'OPENAPI');
  });

  it('skips MARKDOWN_TEMPLATE', () => {
    const r = mapLegacyPageToNavPayload({ type: 'MARKDOWN_TEMPLATE', content: 'x' });
    assert.equal(r.kind, 'SKIP');
    assert.match(r.reason, /template/i);
  });

  it('skips TRANSLATION', () => {
    const r = mapLegacyPageToNavPayload({ type: 'TRANSLATION', content: 'x' });
    assert.equal(r.kind, 'SKIP');
    assert.match(r.reason, /Translation/i);
  });

  it('skips ASYNCAPI', () => {
    const r = mapLegacyPageToNavPayload({ type: 'ASYNCAPI', content: 'asyncapi: 2' });
    assert.equal(r.kind, 'SKIP');
    assert.match(r.reason, /AsyncAPI/i);
  });

  it('skips ASCIIDOC', () => {
    const r = mapLegacyPageToNavPayload({ type: 'ASCIIDOC', content: '= t' });
    assert.equal(r.kind, 'SKIP');
    assert.match(r.reason, /AsciiDoc/i);
  });

  it('skips unknown types with generic reason', () => {
    const r = mapLegacyPageToNavPayload({ type: 'UNKNOWN_TYPE', content: '' });
    assert.equal(r.kind, 'SKIP');
    assert.ok(r.legacyType === 'UNKNOWN_TYPE' || String(r.reason).includes('UNKNOWN'));
  });
});

describe('nextRootOrder', () => {
  it('returns 0 when no roots', () => {
    assert.equal(nextRootOrder([]), 0);
  });

  it('returns max order + 1', () => {
    assert.equal(nextRootOrder([{ order: 0 }, { order: 3 }, { order: 1 }]), 4);
  });

  it('ignores non-numeric order', () => {
    assert.equal(nextRootOrder([{ order: 2 }, { order: undefined }]), 3);
  });
});

describe('apiDisplayName', () => {
  const apis = [{ id: 'a1', name: 'Payments API' }];

  it('resolves name from apis list', () => {
    assert.equal(apiDisplayName('a1', apis), 'Payments API');
  });

  it('falls back to id when not found', () => {
    assert.equal(apiDisplayName('missing', apis), 'missing');
  });
});

describe('createReport + formatMigrationReportMarkdown', () => {
  it('renders summary and tables', () => {
    const report = createReport(sampleCfg);
    report.structure.push({ role: 'Root migration folder', title: 'DOCUMENTATION_MIGRATION' });
    report.migrated.push({
      scope: 'ENVIRONMENT',
      legacyPageId: 'p1',
      title: 'Intro',
      legacyType: 'MARKDOWN',
      result: 'ok',
    });
    report.skipped.push({
      scope: 'API',
      apiId: 'a1',
      apiName: 'My API',
      legacyPageId: 'p2',
      title: 'Old',
      legacyType: 'ASCIIDOC',
      reason: 'manual',
    });

    const md = formatMigrationReportMarkdown(report);
    assert.match(md, /Portal navigation migration report/);
    assert.match(md, /DOCUMENTATION_MIGRATION/);
    assert.match(md, /Intro/);
    assert.match(md, /ASCIIDOC/);
    assert.match(md, /manual/);
  });

  it('escapes pipes in markdown table cells', () => {
    const report = createReport(sampleCfg);
    report.migrated.push({
      scope: 'ENVIRONMENT',
      legacyPageId: 'x',
      title: 'a|b',
      legacyType: 'MARKDOWN',
      result: 'r|z',
    });
    const md = formatMigrationReportMarkdown(report);
    assert.ok(md.includes('a\\|b'));
    assert.ok(md.includes('r\\|z'));
  });

  it('adds dry-run banner when dryRun is true', () => {
    const report = createReport(sampleCfg);
    report.dryRun = true;
    const md = formatMigrationReportMarkdown(report);
    assert.match(md, /DRY RUN/);
  });

  it('includes abortReason when set', () => {
    const report = createReport(sampleCfg);
    report.abortReason = 'No pages';
    report.status = 'aborted_no_pages';
    const md = formatMigrationReportMarkdown(report);
    assert.match(md, /No pages/);
  });

  it('renders idempotent skip banner when status is skipped_already_migrated', () => {
    const report = createReport(sampleCfg);
    report.status = 'skipped_already_migrated';
    report.abortReason = 'Folder exists';
    const md = formatMigrationReportMarkdown(report);
    assert.match(md, /Already migrated/);
    assert.match(md, /idempotent/i);
  });
});

describe('escapeMdCell', () => {
  it('escapes pipes and newlines', () => {
    assert.equal(escapeMdCell('a|b'), 'a\\|b');
    assert.equal(escapeMdCell('x\ny'), 'x y');
  });
});

describe('collectReferencedApiIdsFromNavItems', () => {
  it('collects apiId from API-type items only', () => {
    const items = [
      { type: 'FOLDER', title: 'X' },
      { type: 'API', apiId: '11111111-1111-1111-1111-111111111111', title: 'A' },
      { type: 'PAGE', title: 'P' },
      { type: 'api', apiId: '22222222-2222-2222-2222-222222222222' },
    ];
    const set = collectReferencedApiIdsFromNavItems(items);
    assert.equal(set.size, 2);
    assert.ok(set.has('11111111-1111-1111-1111-111111111111'));
    assert.ok(set.has('22222222-2222-2222-2222-222222222222'));
  });

  it('returns empty set for non-arrays', () => {
    assert.equal(collectReferencedApiIdsFromNavItems(null).size, 0);
    assert.equal(collectReferencedApiIdsFromNavItems(undefined).size, 0);
  });
});

// ---------------------------------------------------------------------------
// Business logic tests for migrateSubtreeFlat
// ---------------------------------------------------------------------------

function mkPage(overrides) {
  return { _scope: 'API', _apiId: 'api-1', ...overrides };
}

function freshReport() {
  return createReport(sampleCfg);
}

function mockIo() {
  const created = [];
  const contentUpdates = [];

  mock.method(io, 'createNavItem', async (_cfg, body) => {
    const item = { ...body, id: randomUUID(), portalPageContentId: randomUUID() };
    created.push(item);
    return item;
  });
  mock.method(io, 'updateContent', async (_cfg, portalPageContentId, content) => {
    contentUpdates.push({ portalPageContentId, content });
  });
  mock.method(io, 'loadContent', async (_cfg, page) => page);

  return { created, contentUpdates };
}

afterEach(() => mock.restoreAll());

describe('migrateSubtreeFlat — tree building', () => {
  it('migrates flat root-level pages in order', async () => {
    const pages = [
      mkPage({ id: 'p1', name: 'Second', type: 'MARKDOWN', content: '# B', order: 2 }),
      mkPage({ id: 'p2', name: 'First', type: 'MARKDOWN', content: '# A', order: 1 }),
    ];
    const subsetIds = new Set(['p1', 'p2']);
    const report = freshReport();
    const { created, contentUpdates } = mockIo();

    await migrateSubtreeFlat(sampleCfg, pages, subsetIds, 'root-nav', 0, false, undefined, report, []);

    assert.equal(created.length, 2);
    assert.equal(created[0].title, 'First');
    assert.equal(created[0].order, 0);
    assert.equal(created[0].parentId, 'root-nav');
    assert.equal(created[1].title, 'Second');
    assert.equal(created[1].order, 1);
    assert.equal(contentUpdates.length, 2);
    assert.equal(report.migrated.length, 2);
  });

  it('nests children inside folders', async () => {
    const pages = [
      mkPage({ id: 'f1', name: 'Folder', type: 'FOLDER', order: 0 }),
      mkPage({ id: 'p1', name: 'Child Page', type: 'MARKDOWN', content: 'body', parentId: 'f1', order: 0 }),
    ];
    const subsetIds = new Set(['f1', 'p1']);
    const report = freshReport();
    const { created } = mockIo();

    await migrateSubtreeFlat(sampleCfg, pages, subsetIds, 'root-nav', 0, false, undefined, report, []);

    assert.equal(created.length, 2);
    const folder = created[0];
    assert.equal(folder.type, 'FOLDER');
    assert.equal(folder.parentId, 'root-nav');
    const child = created[1];
    assert.equal(child.type, 'PAGE');
    assert.equal(child.parentId, folder.id);
    assert.equal(report.migrated.length, 2);
  });

  it('handles deeply nested folders', async () => {
    const pages = [
      mkPage({ id: 'f1', name: 'Level 1', type: 'FOLDER', order: 0 }),
      mkPage({ id: 'f2', name: 'Level 2', type: 'FOLDER', parentId: 'f1', order: 0 }),
      mkPage({ id: 'p1', name: 'Deep Page', type: 'MARKDOWN', content: 'deep', parentId: 'f2', order: 0 }),
    ];
    const subsetIds = new Set(['f1', 'f2', 'p1']);
    const report = freshReport();
    const { created } = mockIo();

    await migrateSubtreeFlat(sampleCfg, pages, subsetIds, 'root-nav', 0, false, undefined, report, []);

    assert.equal(created.length, 3);
    const [l1, l2, page] = created;
    assert.equal(l1.parentId, 'root-nav');
    assert.equal(l2.parentId, l1.id);
    assert.equal(page.parentId, l2.id);
  });

  it('promotes children whose parent is not in subsetIds to root level', async () => {
    const pages = [
      mkPage({ id: 'p1', name: 'Orphan', type: 'MARKDOWN', content: 'x', parentId: 'missing-folder', order: 0 }),
    ];
    const subsetIds = new Set(['p1']);
    const report = freshReport();
    const { created } = mockIo();

    await migrateSubtreeFlat(sampleCfg, pages, subsetIds, 'root-nav', 0, false, undefined, report, []);

    assert.equal(created.length, 1);
    assert.equal(created[0].parentId, 'root-nav');
  });

  it('maps SWAGGER pages to OPENAPI content type', async () => {
    const pages = [
      mkPage({ id: 'p1', name: 'Spec', type: 'SWAGGER', content: '{"openapi":"3.0"}', order: 0 }),
    ];
    const subsetIds = new Set(['p1']);
    const report = freshReport();
    const { created, contentUpdates } = mockIo();

    await migrateSubtreeFlat(sampleCfg, pages, subsetIds, 'root-nav', 0, false, undefined, report, []);

    assert.equal(created[0].contentType, 'OPENAPI');
    assert.equal(contentUpdates[0].content, '{"openapi":"3.0"}');
  });

  it('creates LINK nav items with the URL from page content', async () => {
    const pages = [
      mkPage({ id: 'l1', name: 'Docs', type: 'LINK', content: 'https://docs.example.com', configuration: {}, order: 0 }),
    ];
    const subsetIds = new Set(['l1']);
    const report = freshReport();
    const { created } = mockIo();

    await migrateSubtreeFlat(sampleCfg, pages, subsetIds, 'root-nav', 0, false, undefined, report, []);

    assert.equal(created.length, 1);
    assert.equal(created[0].type, 'LINK');
    assert.equal(created[0].url, 'https://docs.example.com');
  });

  it('respects orderOffset for the first level', async () => {
    const pages = [
      mkPage({ id: 'p1', name: 'Page', type: 'MARKDOWN', content: 'x', order: 0 }),
    ];
    const subsetIds = new Set(['p1']);
    const { created } = mockIo();

    await migrateSubtreeFlat(sampleCfg, pages, subsetIds, 'root-nav', 5, false, undefined, freshReport(), []);

    assert.equal(created[0].order, 5);
  });

  it('deduplicates sibling titles', async () => {
    const pages = [
      mkPage({ id: 'p1', name: 'Doc', type: 'MARKDOWN', content: 'a', order: 0 }),
      mkPage({ id: 'p2', name: 'Doc', type: 'MARKDOWN', content: 'b', order: 1 }),
      mkPage({ id: 'p3', name: 'Doc', type: 'MARKDOWN', content: 'c', order: 2 }),
    ];
    const subsetIds = new Set(['p1', 'p2', 'p3']);
    const { created } = mockIo();

    await migrateSubtreeFlat(sampleCfg, pages, subsetIds, 'root-nav', 0, false, undefined, freshReport(), []);

    const titles = created.map((c) => c.title);
    assert.deepEqual(titles, ['Doc', 'Doc (1)', 'Doc (2)']);
  });

  it('reserves initialSiblingTitles so pages do not clash with pre-existing names', async () => {
    const pages = [
      mkPage({ id: 'p1', name: 'HOMEPAGE', type: 'MARKDOWN', content: 'x', order: 0 }),
    ];
    const subsetIds = new Set(['p1']);
    const { created } = mockIo();

    await migrateSubtreeFlat(sampleCfg, pages, subsetIds, 'root-nav', 0, false, new Set(['HOMEPAGE']), freshReport(), []);

    assert.equal(created[0].title, 'HOMEPAGE (1)');
  });
});

describe('migrateSubtreeFlat — skipped types', () => {
  it('skips ASYNCAPI, ASCIIDOC, MARKDOWN_TEMPLATE, TRANSLATION and records them', async () => {
    const pages = [
      mkPage({ id: 's1', name: 'Async', type: 'ASYNCAPI', content: 'x', order: 0 }),
      mkPage({ id: 's2', name: 'Ascii', type: 'ASCIIDOC', content: 'x', order: 1 }),
      mkPage({ id: 's3', name: 'Tmpl', type: 'MARKDOWN_TEMPLATE', content: 'x', order: 2 }),
      mkPage({ id: 's4', name: 'Trans', type: 'TRANSLATION', content: 'x', order: 3 }),
      mkPage({ id: 'p1', name: 'Good Page', type: 'MARKDOWN', content: 'ok', order: 4 }),
    ];
    const subsetIds = new Set(['s1', 's2', 's3', 's4', 'p1']);
    const report = freshReport();
    const { created } = mockIo();

    await migrateSubtreeFlat(sampleCfg, pages, subsetIds, 'root-nav', 0, false, undefined, report, []);

    assert.equal(created.length, 1);
    assert.equal(created[0].title, 'Good Page');
    assert.equal(report.skipped.length, 4);
    const skippedNames = report.skipped.map((s) => s.title);
    assert.ok(skippedNames.includes('Async'));
    assert.ok(skippedNames.includes('Ascii'));
    assert.ok(skippedNames.includes('Tmpl'));
    assert.ok(skippedNames.includes('Trans'));
  });

  it('skipped pages do not affect sibling order', async () => {
    const pages = [
      mkPage({ id: 'p1', name: 'Before', type: 'MARKDOWN', content: 'a', order: 0 }),
      mkPage({ id: 's1', name: 'Skip Me', type: 'ASYNCAPI', content: 'x', order: 1 }),
      mkPage({ id: 'p2', name: 'After', type: 'MARKDOWN', content: 'b', order: 2 }),
    ];
    const subsetIds = new Set(['p1', 's1', 'p2']);
    const { created } = mockIo();

    await migrateSubtreeFlat(sampleCfg, pages, subsetIds, 'root-nav', 0, false, undefined, freshReport(), []);

    assert.equal(created.length, 2);
    assert.equal(created[0].title, 'Before');
    assert.equal(created[0].order, 0);
    assert.equal(created[1].title, 'After');
    assert.equal(created[1].order, 1);
  });
});

describe('migrateSubtreeFlat — error handling', () => {
  it('gracefully skips a page when createNavItem fails and continues', async () => {
    const report = freshReport();
    const contentUpdates = [];
    let callCount = 0;

    mock.method(io, 'createNavItem', async (_cfg, body) => {
      callCount++;
      if (callCount === 1) throw new Error('HTTP 400 Bad Request');
      return { ...body, id: randomUUID(), portalPageContentId: randomUUID() };
    });
    mock.method(io, 'updateContent', async (_cfg, id, content) => {
      contentUpdates.push({ id, content });
    });
    mock.method(io, 'loadContent', async (_cfg, page) => page);

    const pages = [
      mkPage({ id: 'p1', name: 'Will Fail', type: 'MARKDOWN', content: 'a', order: 0 }),
      mkPage({ id: 'p2', name: 'Will Succeed', type: 'MARKDOWN', content: 'b', order: 1 }),
    ];
    const subsetIds = new Set(['p1', 'p2']);

    await migrateSubtreeFlat(sampleCfg, pages, subsetIds, 'root-nav', 0, false, undefined, report, []);

    assert.equal(report.skipped.length, 1);
    assert.match(report.skipped[0].reason, /Migration failed/);
    assert.equal(report.skipped[0].title, 'Will Fail');
    assert.equal(report.migrated.length, 1);
    assert.equal(report.migrated[0].title, 'Will Succeed');
    assert.equal(contentUpdates.length, 1);
  });

  it('gracefully skips a page when updateContent fails', async () => {
    let updateCallCount = 0;

    mock.method(io, 'createNavItem', async (_cfg, body) => ({
      ...body, id: randomUUID(), portalPageContentId: randomUUID(),
    }));
    mock.method(io, 'updateContent', async () => {
      updateCallCount++;
      if (updateCallCount === 1) throw new Error('HTTP 500');
    });
    mock.method(io, 'loadContent', async (_cfg, page) => page);

    const pages = [
      mkPage({ id: 'p1', name: 'Content Fails', type: 'MARKDOWN', content: 'body', order: 0 }),
      mkPage({ id: 'p2', name: 'Next', type: 'MARKDOWN', content: 'ok', order: 1 }),
    ];
    const subsetIds = new Set(['p1', 'p2']);
    const report = freshReport();

    await migrateSubtreeFlat(sampleCfg, pages, subsetIds, 'root-nav', 0, false, undefined, report, []);

    assert.equal(report.skipped.length, 1);
    assert.match(report.skipped[0].reason, /HTTP 500/);
    assert.equal(report.migrated.length, 1);
    assert.equal(report.migrated[0].title, 'Next');
  });

  it('a failing folder does not block its sibling pages', async () => {
    let callCount = 0;

    mock.method(io, 'createNavItem', async (_cfg, body) => {
      callCount++;
      if (callCount === 1) throw new Error('folder creation failed');
      return { ...body, id: randomUUID(), portalPageContentId: randomUUID() };
    });
    mock.method(io, 'updateContent', async () => {});
    mock.method(io, 'loadContent', async (_cfg, page) => page);

    const pages = [
      mkPage({ id: 'f1', name: 'Bad Folder', type: 'FOLDER', order: 0 }),
      mkPage({ id: 'c1', name: 'Child', type: 'MARKDOWN', content: 'x', parentId: 'f1', order: 0 }),
      mkPage({ id: 'p1', name: 'Sibling', type: 'MARKDOWN', content: 'ok', order: 1 }),
    ];
    const subsetIds = new Set(['f1', 'c1', 'p1']);
    const report = freshReport();

    await migrateSubtreeFlat(sampleCfg, pages, subsetIds, 'root-nav', 0, false, undefined, report, []);

    assert.equal(report.skipped.length, 1);
    assert.equal(report.skipped[0].title, 'Bad Folder');
    assert.equal(report.migrated.length, 1);
    assert.equal(report.migrated[0].title, 'Sibling');
  });
});

describe('migrateSubtreeFlat — content loading', () => {
  it('calls loadContent when fetchContent is true and page has no content', async () => {
    const { created } = mockIo();
    const loadContentMock = io.loadContent.mock;
    mock.method(io, 'loadContent', async (_cfg, page) => {
      return { ...page, content: '# Loaded from detail' };
    });

    const pages = [
      mkPage({ id: 'p1', name: 'Empty', type: 'MARKDOWN', content: '', order: 0 }),
    ];
    const subsetIds = new Set(['p1']);
    const report = freshReport();

    await migrateSubtreeFlat(sampleCfg, pages, subsetIds, 'root-nav', 0, true, undefined, report, []);

    assert.equal(io.loadContent.mock.callCount(), 1);
    assert.equal(report.migrated.length, 1);
  });

  it('does not call loadContent when fetchContent is false', async () => {
    mockIo();

    const pages = [
      mkPage({ id: 'p1', name: 'Page', type: 'MARKDOWN', content: '', order: 0 }),
    ];
    const subsetIds = new Set(['p1']);

    await migrateSubtreeFlat(sampleCfg, pages, subsetIds, 'root-nav', 0, false, undefined, freshReport(), []);

    assert.equal(io.loadContent.mock.callCount(), 0);
  });
});

describe('migrateSubtreeFlat — mixed real-world scenario', () => {
  it('migrates a full API page tree with folders, pages, links, and skipped types', async () => {
    const pages = [
      mkPage({ id: 'hp', name: 'Getting Started', type: 'MARKDOWN', content: '# Welcome', order: 0 }),
      mkPage({ id: 'f1', name: 'Guides', type: 'FOLDER', order: 1 }),
      mkPage({ id: 'g1', name: 'Authentication', type: 'MARKDOWN', content: '# Auth', parentId: 'f1', order: 0 }),
      mkPage({ id: 'g2', name: 'Rate Limiting', type: 'MARKDOWN', content: '# Rates', parentId: 'f1', order: 1 }),
      mkPage({ id: 'spec', name: 'OpenAPI Spec', type: 'SWAGGER', content: '{"openapi":"3.0.0"}', order: 2 }),
      mkPage({ id: 'async', name: 'Events', type: 'ASYNCAPI', content: 'asyncapi: 2.0.0', order: 3 }),
      mkPage({ id: 'lnk', name: 'External', type: 'LINK', content: 'https://example.com', configuration: { resourceType: 'external' }, order: 4 }),
      mkPage({ id: 'asc', name: 'Legacy', type: 'ASCIIDOC', content: '= Title', order: 5 }),
    ];
    const subsetIds = new Set(pages.map((p) => p.id));
    const report = freshReport();
    const { created, contentUpdates } = mockIo();

    await migrateSubtreeFlat(sampleCfg, pages, subsetIds, 'api-nav', 0, false, undefined, report, []);

    assert.equal(report.skipped.length, 2, 'ASYNCAPI and ASCIIDOC should be skipped');
    assert.equal(report.migrated.length, 6, 'all non-skipped pages should be migrated');

    const types = created.map((c) => c.type);
    assert.ok(types.includes('FOLDER'));
    assert.ok(types.includes('PAGE'));
    assert.ok(types.includes('LINK'));

    const folder = created.find((c) => c.type === 'FOLDER');
    const folderChildren = created.filter((c) => c.parentId === folder.id);
    assert.equal(folderChildren.length, 2, 'folder should contain Auth and Rate Limiting');

    const swaggerPage = created.find((c) => c.contentType === 'OPENAPI');
    assert.ok(swaggerPage, 'SWAGGER should map to OPENAPI');

    const swaggerContent = contentUpdates.find((u) => u.portalPageContentId === swaggerPage.portalPageContentId);
    assert.equal(swaggerContent.content, '{"openapi":"3.0.0"}');

    const link = created.find((c) => c.type === 'LINK');
    assert.equal(link.url, 'https://example.com');
  });
});

describe('mapLegacyPageToNavPayload — LINK edge cases', () => {
  it('maps empty-content link to placeholder URL', () => {
    const r = mapLegacyPageToNavPayload({ type: 'LINK', content: '', configuration: {} });
    assert.equal(r.kind, 'LINK');
    assert.ok(r.url.includes('invalid.invalid'));
    assert.ok(r.url.includes('legacy-empty-link'));
  });

  it('maps category resourceType link to placeholder with ref', () => {
    const r = mapLegacyPageToNavPayload({
      type: 'LINK',
      content: 'my-category',
      configuration: { resourceType: 'category' },
    });
    assert.equal(r.kind, 'LINK');
    assert.ok(r.url.includes('resourceType=category'));
    assert.ok(r.url.includes('ref=my-category'));
  });

  it('detects external URL from content even without resourceType', () => {
    const r = mapLegacyPageToNavPayload({
      type: 'LINK',
      content: 'https://external.example.com/docs',
      configuration: {},
    });
    assert.equal(r.kind, 'LINK');
    assert.equal(r.url, 'https://external.example.com/docs');
  });
});

// ---------------------------------------------------------------------------
// targetApimVersion: the version of the APIM server the documentation is migrated into
// ---------------------------------------------------------------------------

describe('parseTargetApimVersion', () => {
  it('accepts major.minor', () => {
    assert.equal(parseTargetApimVersion('4.12'), '4.12');
    assert.equal(parseTargetApimVersion('4.13'), '4.13');
    assert.equal(parseTargetApimVersion('4.100'), '4.100');
  });

  for (const value of [undefined, null, '', '4', '4.13.1', 'v4.13', '4.13.x', ' 4.13', '4.13 ', 4.13]) {
    it(`rejects ${JSON.stringify(value)} with the expected format`, () => {
      assert.throws(() => parseTargetApimVersion(value), /targetApimVersion.*major\.minor.*4\.13/s);
    });
  }
});

describe('writerFor', () => {
  it('selects the listing-row writer for 4.11 and 4.12', () => {
    assert.equal(writerFor('4.11'), 'portal');
    assert.equal(writerFor('4.12'), 'portal');
  });

  it('selects the API-owned writer for 4.13 and later', () => {
    assert.equal(writerFor('4.13'), 'api');
    assert.equal(writerFor('4.14'), 'api');
    assert.equal(writerFor('5.0'), 'api');
  });

  it('compares versions numerically', () => {
    assert.equal(writerFor('4.100'), 'api');
    assert.throws(() => writerFor('4.9'), /4\.11/);
  });

  it('refuses a version older than the Next Gen portal navigation', () => {
    assert.throws(() => writerFor('4.10'), /4\.11 or later/);
  });
});

describe('checkTargetVersionAgainstServer', () => {
  it('passes when the API-owned writer meets a server with the API-scoped endpoints', async () => {
    mock.method(io, 'hasApiScopedDocumentation', async () => true);
    await checkTargetVersionAgainstServer(sampleCfg, '4.13', 'api-1');
  });

  it('passes when the listing-row writer meets a server without them', async () => {
    mock.method(io, 'hasApiScopedDocumentation', async () => false);
    await checkTargetVersionAgainstServer(sampleCfg, '4.12', 'api-1');
  });

  it('stops when 4.13 or later meets a server without the API-scoped endpoints', async () => {
    mock.method(io, 'hasApiScopedDocumentation', async () => false);
    await assert.rejects(
      () => checkTargetVersionAgainstServer(sampleCfg, '4.13', 'api-1'),
      /does not provide API-owned documentation.*targetApimVersion.*baseUrl/s,
    );
  });

  it('stops when 4.11 or 4.12 meets a server that stores documentation as owned by the API', async () => {
    mock.method(io, 'hasApiScopedDocumentation', async () => true);
    await assert.rejects(
      () => checkTargetVersionAgainstServer(sampleCfg, '4.12', 'api-1'),
      /owned by the API.*targetApimVersion.*baseUrl/s,
    );
  });
});

// ---------------------------------------------------------------------------
// The API-owned writer through migrateSubtreeFlat
// ---------------------------------------------------------------------------

function mockApiIo() {
  const created = [];
  const contentUpdates = [];
  mock.method(io, 'createApiNavItem', async (_cfg, apiId, body) => {
    const item = { ...body, id: randomUUID() };
    created.push({ apiId, ...item });
    return item;
  });
  mock.method(io, 'updateApiContent', async (_cfg, apiId, navId, content) => {
    contentUpdates.push({ apiId, navId, content });
  });
  mock.method(io, 'loadContent', async (_cfg, page) => page);
  return { created, contentUpdates };
}

describe('migrateSubtreeFlat — API-owned writer', () => {
  it('creates top items with no parent and nested items under their folder, through the API path', async () => {
    const pages = [
      mkPage({ id: 'f1', name: 'Guides', type: 'FOLDER', order: 0 }),
      mkPage({ id: 'p1', name: 'Auth', type: 'MARKDOWN', content: '# Auth', parentId: 'f1', order: 0 }),
      mkPage({ id: 'p2', name: 'Intro', type: 'MARKDOWN', content: '# Intro', order: 1 }),
    ];
    const { created } = mockApiIo();

    await migrateSubtreeFlat(sampleCfg, pages, new Set(['f1', 'p1', 'p2']), null, 0, false, undefined, freshReport(), [], apiOwnedWriter('api-1'));

    assert.equal(created.length, 3);
    assert.ok(created.every((c) => c.apiId === 'api-1'));
    const folder = created.find((c) => c.title === 'Guides');
    assert.equal('parentId' in folder, false);
    assert.equal(created.find((c) => c.title === 'Auth').parentId, folder.id);
    assert.equal('parentId' in created.find((c) => c.title === 'Intro'), false);
  });

  it('saves a page content through the page, without a content id', async () => {
    const pages = [mkPage({ id: 'p1', name: 'Intro', type: 'MARKDOWN', content: '# Intro', order: 0 })];
    const { created, contentUpdates } = mockApiIo();

    await migrateSubtreeFlat(sampleCfg, pages, new Set(['p1']), null, 0, false, undefined, freshReport(), [], apiOwnedWriter('api-1'));

    assert.deepEqual(contentUpdates, [{ apiId: 'api-1', navId: created[0].id, content: '# Intro' }]);
  });

  it('migrates AsyncAPI pages as ASYNCAPI content', async () => {
    const pages = [mkPage({ id: 'p1', name: 'Events', type: 'ASYNCAPI', content: 'asyncapi: 2.0.0', order: 0 })];
    const report = freshReport();
    const { created, contentUpdates } = mockApiIo();

    await migrateSubtreeFlat(sampleCfg, pages, new Set(['p1']), null, 0, false, undefined, report, [], apiOwnedWriter('api-1'));

    assert.equal(created[0].contentType, 'ASYNCAPI');
    assert.equal(contentUpdates[0].content, 'asyncapi: 2.0.0');
    assert.equal(report.skipped.length, 0);
  });
});

// ---------------------------------------------------------------------------
// runMigration against a fake Management API
// ---------------------------------------------------------------------------

const API_V4 = { id: 'api-4', name: 'Payments', definitionVersion: 'V4' };
const API_V2 = { id: 'api-2', name: 'Legacy', definitionVersion: 'V2' };

function runCfg(targetApimVersion) {
  return { ...sampleCfg, targetApimVersion };
}

function runOptions(overrides = {}) {
  return { dryRun: false, reportPath: join(tmpdir(), `migration-report-${randomUUID()}.md`), ...overrides };
}

/**
 * A Management API holding the given state. `apiScoped` says whether it has the API-scoped documentation
 * endpoints, as 4.13 and later do. Every request is recorded in the returned array.
 */
function fakeServer({ apiScoped, roots = [], envPages = [], apis = [], apiPages = {}, documentation = {}, failCreate = () => false, failContent = () => false, probeStatus, pageDetails = {} } = {}) {
  const calls = [];
  const respond = (status, body) =>
    new Response(body === undefined ? '' : JSON.stringify(body), { status, statusText: String(status) });

  mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const method = options.method || 'GET';
    const { pathname, searchParams } = new URL(url);
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ method, pathname, body });

    const apiPath = pathname.match(/\/apis\/([^/]+)\/portal-navigation-items(.*)$/);
    if (apiPath) {
      const [, apiId, rest] = apiPath;
      if (rest === '/_publish-locations') return probeStatus ? respond(probeStatus, {}) : respond(apiScoped ? 200 : 404, { data: [] });
      if (!apiScoped) return respond(404, { message: 'Not found' });
      if (rest === '' && method === 'GET') return respond(200, { items: documentation[apiId] || [], publications: [] });
      if (rest === '' && method === 'POST') {
        if (failCreate(body)) return respond(400, { message: 'refused' });
        return respond(201, { ...body, id: randomUUID() });
      }
      if (rest.endsWith('/content') && method === 'PUT') {
        if (failContent(body)) return respond(400, { message: 'invalid content' });
        return respond(200, { content: body.content });
      }
    }
    if (pathname.endsWith('/portal/pages')) return respond(200, envPages);
    if (/\/apis\/[^/]+\/pages$/.test(pathname)) return respond(200, { pages: apiPages[pathname.split('/').at(-2)] || [] });
    const detail = pathname.match(/\/apis\/[^/]+\/pages\/([^/]+)$/);
    if (detail && pageDetails[detail[1]]) return respond(200, pageDetails[detail[1]]);
    if (pathname.endsWith('/apis')) return respond(200, { data: apis, pagination: { pageCount: 1 } });
    if (pathname.endsWith('/portal-navigation-items') && method === 'GET') {
      return respond(200, { items: searchParams.get('loadChildren') === 'true' ? roots : roots.filter((r) => r.parentId == null) });
    }
    if (pathname.endsWith('/portal-navigation-items') && method === 'POST') {
      return respond(201, { ...body, id: randomUUID(), portalPageContentId: randomUUID() });
    }
    if (pathname.includes('/portal-page-contents/') && method === 'PUT') return respond(200, {});
    return respond(500, { message: `unexpected ${method} ${pathname}` });
  });
  return calls;
}

const writes = (calls) => calls.filter((c) => c.method !== 'GET');
const apiDocPage = (apiId, overrides) => ({ id: randomUUID(), type: 'MARKDOWN', content: '# Doc', order: 0, ...overrides, _apiId: apiId });

describe('runMigration — targetApimVersion 4.13 or later', () => {
  beforeEach(() => mock.method(console, 'log', () => {}));

  it('writes each API documentation through the API path, with no listing row and no APIS folder', async () => {
    const calls = fakeServer({
      apiScoped: true,
      apis: [API_V4],
      apiPages: { 'api-4': [apiDocPage('api-4', { name: 'Intro' })] },
    });

    await runMigration(runCfg('4.13'), runOptions());

    const created = writes(calls).filter((c) => c.method === 'POST');
    assert.deepEqual(created.map((c) => c.pathname.split('/environments/DEFAULT')[1]), ['/apis/api-4/portal-navigation-items']);
    assert.equal(created[0].body.title, 'Intro');
    assert.ok(writes(calls).some((c) => c.method === 'PUT' && c.pathname.includes('/apis/api-4/portal-navigation-items/')));
    assert.ok(!calls.some((c) => c.body?.type === 'API' || c.body?.title === 'APIS'));
  });

  it('skips an API that already has documentation, and reports it', async () => {
    const calls = fakeServer({
      apiScoped: true,
      apis: [API_V4],
      apiPages: { 'api-4': [apiDocPage('api-4', { name: 'Intro' })] },
      documentation: { 'api-4': [{ id: 'existing', type: 'PAGE', title: 'Written in Gamma' }] },
    });
    const options = runOptions();

    const report = await runMigration(runCfg('4.13'), options);

    assert.equal(writes(calls).length, 0);
    assert.deepEqual(report.apis.alreadyDocumented.map((a) => a.apiId), ['api-4']);
  });

  it('migrates an API that has no documentation even when DOCUMENTATION_MIGRATION exists', async () => {
    const calls = fakeServer({
      apiScoped: true,
      roots: [{ id: 'm', title: 'DOCUMENTATION_MIGRATION', parentId: null, type: 'FOLDER' }],
      envPages: [{ id: 'e1', name: 'Env page', type: 'MARKDOWN', content: 'x' }],
      apis: [API_V4],
      apiPages: { 'api-4': [apiDocPage('api-4', { name: 'Intro' })] },
    });

    const report = await runMigration(runCfg('4.13'), runOptions());

    const created = writes(calls).filter((c) => c.method === 'POST');
    assert.ok(created.every((c) => c.pathname.includes('/apis/api-4/')), 'environment documentation stays gated by its folder');
    assert.equal(created.length, 1);
    assert.deepEqual(report.apis.migrated.map((a) => a.apiId), ['api-4']);
  });

  it('migrates environment documentation into DOCUMENTATION_MIGRATION/ENVIRONMENT when the folder is absent', async () => {
    const calls = fakeServer({
      apiScoped: true,
      envPages: [{ id: 'e1', name: 'Env page', type: 'MARKDOWN', content: 'x' }],
      apis: [API_V4],
    });

    await runMigration(runCfg('4.13'), runOptions());

    const titles = writes(calls).filter((c) => c.method === 'POST').map((c) => c.body.title);
    assert.deepEqual(titles, ['DOCUMENTATION_MIGRATION', 'ENVIRONMENT', 'Env page']);
  });

  it('names an API whose migration failed part-way as partially migrated', async () => {
    fakeServer({
      apiScoped: true,
      apis: [API_V4],
      apiPages: {
        'api-4': [
          apiDocPage('api-4', { name: 'First', order: 0 }),
          apiDocPage('api-4', { name: 'Refused', order: 1 }),
        ],
      },
      failCreate: (body) => body.title === 'Refused',
    });

    const report = await runMigration(runCfg('4.13'), runOptions());

    assert.equal(report.apis.partial.length, 1);
    assert.equal(report.apis.partial[0].apiId, 'api-4');
    assert.deepEqual(report.apis.partial[0].created, ['First']);
    assert.match(formatMigrationReportMarkdown(report), /Partially migrated/);
  });

  it("migrates a V2 API's documentation as API-owned, like a V4 API", async () => {
    const calls = fakeServer({
      apiScoped: true,
      apis: [API_V2],
      apiPages: { 'api-2': [apiDocPage('api-2', { name: 'Old doc' })] },
    });

    await runMigration(runCfg('4.13'), runOptions());

    assert.ok(writes(calls).some((c) => c.method === 'POST' && c.pathname.includes('/apis/api-2/portal-navigation-items')));
  });

  it('writes nothing in dry run, while still checking the server and the existing documentation', async () => {
    const calls = fakeServer({
      apiScoped: true,
      apis: [API_V4],
      apiPages: { 'api-4': [apiDocPage('api-4', { name: 'Intro' })] },
    });

    await runMigration(runCfg('4.13'), runOptions({ dryRun: true }));

    assert.equal(writes(calls).length, 0);
    assert.ok(calls.some((c) => c.pathname.endsWith('/apis/api-4/portal-navigation-items/_publish-locations')));
    assert.ok(calls.some((c) => c.method === 'GET' && c.pathname.endsWith('/apis/api-4/portal-navigation-items')));
  });

  it('says which target version and writer ran', async () => {
    fakeServer({ apiScoped: true, apis: [API_V4], apiPages: { 'api-4': [apiDocPage('api-4', { name: 'Intro' })] } });

    const report = await runMigration(runCfg('4.13'), runOptions());

    assert.match(formatMigrationReportMarkdown(report), /Target APIM version.*4\.13/);
    assert.match(formatMigrationReportMarkdown(report), /owned by each API/);
  });
});

describe('runMigration — checks against the server before writing', () => {
  beforeEach(() => mock.method(console, 'log', () => {}));

  it('stops when 4.13 or later meets a server without the API-scoped endpoints', async () => {
    const calls = fakeServer({ apiScoped: false, apis: [API_V4], apiPages: { 'api-4': [apiDocPage('api-4', { name: 'Intro' })] } });

    await assert.rejects(() => runMigration(runCfg('4.13'), runOptions()), /does not provide API-owned documentation/);
    assert.equal(writes(calls).length, 0);
  });

  it('stops when 4.12 meets a server that stores documentation as owned by the API', async () => {
    const calls = fakeServer({ apiScoped: true, apis: [API_V4], apiPages: { 'api-4': [apiDocPage('api-4', { name: 'Intro' })] } });

    await assert.rejects(() => runMigration(runCfg('4.12'), runOptions()), /owned by the API/);
    assert.equal(writes(calls).length, 0);
  });

  it('stops on any other answer from the server', async () => {
    const calls = fakeServer({ probeStatus: 500, apis: [API_V4], apiPages: { 'api-4': [apiDocPage('api-4', { name: 'Intro' })] } });

    await assert.rejects(() => runMigration(runCfg('4.13'), runOptions()), /HTTP 500/);
    assert.equal(writes(calls).length, 0);
  });
});

describe('runMigration — targetApimVersion 4.11 or 4.12', () => {
  beforeEach(() => mock.method(console, 'log', () => {}));

  it('creates a listing row under DOCUMENTATION_MIGRATION/APIS, as before', async () => {
    const calls = fakeServer({ apiScoped: false, apis: [API_V4], apiPages: { 'api-4': [apiDocPage('api-4', { name: 'Intro' })] } });

    await runMigration(runCfg('4.12'), runOptions());

    const created = writes(calls).filter((c) => c.method === 'POST').map((c) => [c.body.type, c.body.title]);
    assert.deepEqual(created, [
      ['FOLDER', 'DOCUMENTATION_MIGRATION'],
      ['FOLDER', 'APIS'],
      ['API', 'Payments'],
      ['PAGE', 'Intro'],
    ]);
  });

  it('still stops at once when DOCUMENTATION_MIGRATION exists', async () => {
    const calls = fakeServer({
      apiScoped: false,
      roots: [{ id: 'm', title: 'DOCUMENTATION_MIGRATION', parentId: null, type: 'FOLDER' }],
      apis: [API_V4],
      apiPages: { 'api-4': [apiDocPage('api-4', { name: 'Intro' })] },
    });

    const report = await runMigration(runCfg('4.12'), runOptions());

    assert.equal(report.status, 'skipped_already_migrated');
    assert.equal(writes(calls).length, 0);
  });
});

// ---------------------------------------------------------------------------
// Legacy pages whose content the portal refuses
// ---------------------------------------------------------------------------

describe('mapLegacyPageToNavPayload — blank content', () => {
  for (const type of ['MARKDOWN', 'SWAGGER']) {
    it(`skips a ${type} page with blank content, before anything is created`, () => {
      const r = mapLegacyPageToNavPayload({ type, content: '  \n' });
      assert.equal(r.kind, 'SKIP');
      assert.match(r.reason, /no content/i);
    });
  }

  it('skips a blank AsyncAPI page with the API-owned writer', () => {
    const r = mapLegacyPageToNavPayload({ type: 'ASYNCAPI', content: '' }, { asyncApi: true });
    assert.equal(r.kind, 'SKIP');
    assert.match(r.reason, /no content/i);
  });
});

describe('ensurePageContent', () => {
  it('still loads the content of a page the list returned without it', async () => {
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ id: 'p1', type: 'MARKDOWN', content: '# Loaded' }), { status: 200 }));

    const page = await ensurePageContent(sampleCfg, { id: 'p1', type: 'MARKDOWN', content: '' }, 'API', 'api-1');

    assert.equal(page.content, '# Loaded');
  });
});

describe('runMigration — content the portal refuses', () => {
  beforeEach(() => mock.method(console, 'log', () => {}));

  it('creates nothing for an API whose only legacy page is empty, so a later run can migrate it', async () => {
    const calls = fakeServer({
      apiScoped: true,
      apis: [API_V4],
      apiPages: { 'api-4': [apiDocPage('api-4', { name: 'Empty', content: '' })] },
    });

    const report = await runMigration(runCfg('4.13'), runOptions());

    assert.equal(writes(calls).length, 0);
    assert.match(report.skipped[0].reason, /no content/i);
    assert.equal(report.apis.partial.length, 0);
  });

  it('reports the API as partially migrated when a page was created but its content refused', async () => {
    fakeServer({
      apiScoped: true,
      apis: [API_V4],
      apiPages: { 'api-4': [apiDocPage('api-4', { name: 'Too big', content: '# x' })] },
      failContent: () => true,
    });

    const report = await runMigration(runCfg('4.13'), runOptions());

    assert.equal(report.apis.partial.length, 1);
    assert.deepEqual(report.apis.partial[0].created, ['Too big']);
    assert.deepEqual(report.apis.partial[0].failed, ['Too big']);
    assert.match(report.skipped[0].reason, /created without its content/i);
  });
});
