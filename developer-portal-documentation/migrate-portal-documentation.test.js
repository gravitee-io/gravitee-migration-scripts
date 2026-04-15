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
import { afterEach, describe, it, mock } from 'node:test';

import {
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
