#!/usr/bin/env node
/**
 * Tests for the Helm memory engine. Run: node --test helm-broker/
 *
 * HELM_HOME is pointed at a throwaway tmp dir BEFORE the module import (the
 * module resolves its paths at load time). Embedding calls are stubbed via
 * globalThis.fetch so no network or API key is needed.
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-memory-test-'));
process.env.HELM_HOME = TMP;
delete process.env.HELM_OPENAI_KEY;
delete process.env.OPENAI_API_KEY;

const memory = await import('./memory.js');

const realFetch = globalThis.fetch;

// Deterministic fake embeddings: a 4-dim vector derived from which of four
// marker words the text contains, so related texts get related vectors.
function fakeVector(text) {
  const t = text.toLowerCase();
  return [
    t.includes('database') || t.includes('postgres') ? 1 : 0.01,
    t.includes('email') || t.includes('outreach') ? 1 : 0.01,
    t.includes('broward') || t.includes('parcel') ? 1 : 0.01,
    t.includes('deploy') ? 1 : 0.01,
  ];
}

function stubEmbeddings() {
  globalThis.fetch = async (url, opts) => {
    assert.match(String(url), /api\.openai\.com\/v1\/embeddings/);
    const { input } = JSON.parse(opts.body);
    const texts = Array.isArray(input) ? input : [input];
    return {
      ok: true,
      json: async () => ({ data: texts.map(t => ({ embedding: fakeVector(t) })) }),
    };
  };
}

function freshState() {
  memory._resetForTests();
  fs.rmSync(path.join(TMP, 'memory'), { recursive: true, force: true });
  memory.init();
}

beforeEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.HELM_OPENAI_KEY;
  freshState();
});

after(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(TMP, { recursive: true, force: true });
});

// ─── Scoring primitives ───────────────────────────────────────────────────────

test('cosine: identical vectors score 1, orthogonal score 0', () => {
  assert.ok(Math.abs(memory.cosine([1, 0], [1, 0]) - 1) < 1e-9);
  assert.equal(memory.cosine([1, 0], [0, 1]), 0);
  assert.equal(memory.cosine([0, 0], [1, 1]), 0); // zero vector guard
  assert.equal(memory.cosine([1, 0, 0], [1, 0]), 0); // dimension mismatch never scores
});

test('keywordScore: fraction of query terms found, exact ids always hit', () => {
  const entry = { text: 'Route creator-profile/analyze migrated to Postgres', tags: ['palm'] };
  assert.equal(memory.keywordScore('postgres palm', entry), 1);
  assert.equal(memory.keywordScore('postgres kubernetes', entry), 0.5);
  assert.equal(memory.keywordScore('creator-profile/analyze', entry), 1); // identifier substring
  assert.equal(memory.keywordScore('nothing matches here', entry), 0);
});

// ─── CRUD + journal replay ────────────────────────────────────────────────────

test('addMemory lands in inbox, survives journal replay', async () => {
  const { entry, semantic } = await memory.addMemory({
    text: 'Palm cutover complete, all routes on Postgres',
    tags: ['palm'],
    source: { peer_id: 'abc', agent_name: 'teammate-02', team_id: 'team-x' },
  });
  assert.equal(entry.status, 'inbox');
  assert.equal(semantic, false); // no key configured

  // Reload from disk: entry must come back identically.
  memory._resetForTests();
  memory.init();
  const { results } = await memory.search('palm postgres');
  assert.equal(results.length, 1);
  assert.equal(results[0].entry.id, entry.id);
  assert.equal(results[0].entry.source.agent_name, 'teammate-02');
});

test('updateMemory promotes and edits; deleteMemory removes, both replay', async () => {
  const { entry } = await memory.addMemory({ text: 'first fact about deploys' });
  const { entry: doomed } = await memory.addMemory({ text: 'second fact, soon gone' });

  memory.updateMemory(entry.id, { status: 'curated', text: 'first fact about deploys, verified' });
  memory.deleteMemory(doomed.id);

  memory._resetForTests();
  memory.init();

  assert.equal(memory.stats().total, 1);
  assert.equal(memory.stats().curated, 1);
  const { results } = await memory.search('deploys verified');
  assert.equal(results[0].entry.status, 'curated');
  assert.match(results[0].entry.text, /verified/);
});

test('updateMemory rejects unknown id and bad status', async () => {
  await memory.addMemory({ text: 'a fact' });
  assert.throws(() => memory.updateMemory('nope', { text: 'x' }), /no memory/);
  const { entry } = await memory.addMemory({ text: 'another fact' });
  assert.throws(() => memory.updateMemory(entry.id, { status: 'weird' }), /bad status/);
});

test('addMemory validates text', async () => {
  await assert.rejects(() => memory.addMemory({ text: '' }), /text required/);
  await assert.rejects(() => memory.addMemory({ text: 'x'.repeat(4001) }), /exceeds/);
});

test('inbox returns only uncurated entries, oldest first', async () => {
  const a = await memory.addMemory({ text: 'inbox one' });
  await memory.addMemory({ text: 'curated one', status: 'curated' });
  await memory.addMemory({ text: 'inbox two' });
  const box = memory.inbox();
  assert.equal(box.length, 2);
  assert.equal(box[0].id, a.entry.id);
});

// ─── Search ───────────────────────────────────────────────────────────────────

test('search without a key is keyword-only and says so', async () => {
  await memory.addMemory({ text: 'Broward parcel scan finished', tags: ['hvi'] });
  await memory.addMemory({ text: 'Email warmup configured' });
  const { results, semantic } = await memory.search('broward');
  assert.equal(semantic, false);
  assert.equal(results.length, 1);
  assert.match(results[0].entry.text, /Broward/);
});

test('semantic search ranks related text above keyword-miss text', async () => {
  process.env.HELM_OPENAI_KEY = 'test-key';
  stubEmbeddings();

  await memory.addMemory({ text: 'Migrated the database to Postgres 16' });
  await memory.addMemory({ text: 'Cold outreach email sequence drafted' });

  // Query shares no keywords with the first entry, but the fake embedding
  // space puts "postgres" and "database" on the same axis.
  const { results, semantic } = await memory.search('database work');
  assert.equal(semantic, true);
  assert.ok(results.length >= 1);
  assert.match(results[0].entry.text, /Postgres/);
});

test('concurrent searches never double-embed: no duplicate vector lines', async () => {
  await memory.addMemory({ text: 'fact one about postgres database' });
  await memory.addMemory({ text: 'fact two about email outreach' });
  assert.equal(memory.stats().embedded, 0);

  process.env.HELM_OPENAI_KEY = 'test-key';
  // Slow stub so the two searches genuinely overlap in the backfill window.
  globalThis.fetch = async (url, opts) => {
    await new Promise(r => setTimeout(r, 20));
    const { input } = JSON.parse(opts.body);
    const texts = Array.isArray(input) ? input : [input];
    return { ok: true, json: async () => ({ data: texts.map(t => ({ embedding: fakeVector(t) })) }) };
  };

  await Promise.all([memory.search('postgres'), memory.search('email')]);
  await memory.search('postgres'); // sweep up anything the skipped call left

  const lines = fs.readFileSync(path.join(TMP, 'memory', 'vectors.jsonl'), 'utf8')
    .trim().split('\n').map(l => JSON.parse(l).id);
  assert.equal(new Set(lines).size, lines.length, `duplicate vector lines: ${lines.join(',')}`);
  assert.equal(memory.stats().embedded, 2);
});

test('vectors backfill on search after a key appears', async () => {
  await memory.addMemory({ text: 'Deploy pipeline fixed' }); // saved with no vector
  assert.equal(memory.stats().embedded, 0);

  process.env.HELM_OPENAI_KEY = 'test-key';
  stubEmbeddings();
  await memory.search('deploy');
  assert.equal(memory.stats().embedded, 1);
});

test('embedding API failure degrades search to keyword, never throws', async () => {
  process.env.HELM_OPENAI_KEY = 'test-key';
  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });

  await memory.addMemory({ text: 'Resilient fact about email' }); // embed fails, entry still saved
  const { results, semantic } = await memory.search('email');
  assert.equal(semantic, false);
  assert.equal(results.length, 1);
});

test('text update invalidates the stale vector until re-embedded', async () => {
  process.env.HELM_OPENAI_KEY = 'test-key';
  stubEmbeddings();
  const { entry } = await memory.addMemory({ text: 'Email outreach started' });
  assert.equal(memory.stats().embedded, 1);
  memory.updateMemory(entry.id, { text: 'Broward parcels imported instead' });
  assert.equal(memory.stats().embedded, 0); // dropped, will backfill with new text
});

// ─── Event log ────────────────────────────────────────────────────────────────

test('logEvent appends JSONL and never throws', () => {
  memory.logEvent('message', { from_id: 'a', to_id: 'b', text: 'hi' });
  memory.logEvent('summary', { peer_id: 'a', summary: 'working' });
  const lines = fs.readFileSync(path.join(TMP, 'memory', 'events.jsonl'), 'utf8')
    .trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].type, 'message');
  assert.ok(lines[0].at);
});

test('init seeds the admiral charter once, never overwrites', () => {
  const charter = path.join(TMP, 'admiral', 'CLAUDE.md');
  assert.ok(fs.existsSync(charter));
  fs.writeFileSync(charter, 'customized by Brett');
  memory._resetForTests();
  memory.init();
  assert.equal(fs.readFileSync(charter, 'utf8'), 'customized by Brett');
});
