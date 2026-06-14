#!/usr/bin/env node
/**
 * Helm Memory
 * Durable, searchable memory for the Helm workspace.
 *
 * Three layers, all plain files under ~/.helm/memory/:
 *   events.jsonl  , automatic append-only log of broker activity (messages,
 *                    summaries, registrations). Lossless capture, no model
 *                    discipline required.
 *   journal.jsonl , memory operations journal ({op: add|update|delete}).
 *                    The in-memory store is rebuilt by replaying it at boot,
 *                    so updates/deletes never rewrite the file.
 *   vectors.jsonl , one embedding per memory id (latest wins at load).
 *
 * Memory entries have a status: 'inbox' (submitted by any teammate, awaiting
 * curation) or 'curated' (promoted/maintained by the Helm orchestrator).
 * Search is hybrid: cosine similarity over OpenAI embeddings blended with
 * keyword overlap, falling back to keyword-only when no API key is configured.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const HELM_DIR = process.env.HELM_HOME || path.join(os.homedir(), '.helm');
const MEMORY_DIR = path.join(HELM_DIR, 'memory');
const ADMIRAL_DIR = path.join(HELM_DIR, 'admiral');
const EVENTS_FILE = path.join(MEMORY_DIR, 'events.jsonl');
const JOURNAL_FILE = path.join(MEMORY_DIR, 'journal.jsonl');
const VECTORS_FILE = path.join(MEMORY_DIR, 'vectors.jsonl');
const CONFIG_FILE = path.join(HELM_DIR, 'config.json');

const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_TIMEOUT_MS = 10_000;
const EMBED_BATCH_MAX = 64;          // OpenAI accepts more; keep requests small
const EVENTS_ROTATE_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_LEN = 4000;
const BACKFILL_PER_SEARCH = 32;      // missing vectors embedded lazily per search
const SEMANTIC_WEIGHT = 0.65;
const KEYWORD_WEIGHT = 0.35;

// In-memory state, rebuilt from the journal at init().
const entries = new Map();  // id -> entry
const vectors = new Map();  // id -> Float64Array

function nowIso() {
  return new Date().toISOString();
}

function uid() {
  return crypto.randomBytes(6).toString('hex');
}

function appendLine(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

function readLines(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip torn line from a crash */ }
  }
  return out;
}

// ─── Init ─────────────────────────────────────────────────────────────────────

const ADMIRAL_CLAUDE_MD = `# The Helm

You are the Helm, the orchestrator above every team in this workspace. This
directory is your home and your memory. Read this file and ./state/ at the
start of every session before doing anything else.

## Your job
- Hold the cross-team picture. Know what every team is doing and why.
- Prompt and direct team leads (not individual workers) via send_message.
- Reallocate focus when a team stalls or two teams should be talking.
- Maintain memory: review the inbox (review_memory_inbox), promote what
  matters (curate_memory), update or delete what went stale.
- Keep ./state/<team>.md current, one file per team: goal, status, open
  threads, decisions. Update them after meaningful exchanges.

## Your tools (helm-teammates MCP)
- list_teams, every team and its live agents
- send_message / message_team, reach any teammate or broadcast to any team
- recall_memory / add_memory, semantic memory, shared with all teammates
- review_memory_inbox / curate_memory, your curation rights (only you)

## Rules
- You orchestrate; you do not do object-level work yourself.
- Compress upward: leads send you summaries, you keep judgment-level state.
- After any decision that changes direction, write it to ./state/decisions.md.
`;

let initialized = false;

export function init() {
  if (initialized) return;
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.mkdirSync(path.join(ADMIRAL_DIR, 'state'), { recursive: true });

  const claudeMd = path.join(ADMIRAL_DIR, 'CLAUDE.md');
  if (!fs.existsSync(claudeMd)) fs.writeFileSync(claudeMd, ADMIRAL_CLAUDE_MD);

  // Replay the journal: adds, then updates/deletes in order.
  for (const op of readLines(JOURNAL_FILE)) {
    if (op.op === 'add' && op.entry?.id) entries.set(op.entry.id, op.entry);
    else if (op.op === 'update' && op.id && entries.has(op.id)) {
      entries.set(op.id, { ...entries.get(op.id), ...op.patch, updated_at: op.at });
    } else if (op.op === 'delete' && op.id) entries.delete(op.id);
  }
  for (const v of readLines(VECTORS_FILE)) {
    if (v.id && Array.isArray(v.vector) && entries.has(v.id)) {
      vectors.set(v.id, Float64Array.from(v.vector));
    }
  }
  initialized = true;
}

// ─── Event log (automatic capture) ────────────────────────────────────────────

export function logEvent(type, data) {
  try {
    try {
      const st = fs.statSync(EVENTS_FILE);
      if (st.size > EVENTS_ROTATE_BYTES) {
        fs.renameSync(EVENTS_FILE, path.join(MEMORY_DIR, `events-${Date.now()}.jsonl`));
      }
    } catch { /* no file yet */ }
    appendLine(EVENTS_FILE, { at: nowIso(), type, ...data });
  } catch (err) {
    // Memory capture must never take the broker down with it.
    console.error(`[helm-memory] event log failed: ${err.message}`);
  }
}

// ─── Embeddings ───────────────────────────────────────────────────────────────

function apiKey() {
  if (process.env.HELM_OPENAI_KEY) return process.env.HELM_OPENAI_KEY;
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (cfg.openaiApiKey) return cfg.openaiApiKey;
  } catch { /* no config file */ }
  return null;
}

export function semanticAvailable() {
  return !!apiKey();
}

async function embed(texts) {
  const key = apiKey();
  if (!key) throw new Error('no embedding API key configured');
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`embeddings API ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json.data.map(d => Float64Array.from(d.embedding));
}

function embeddableText(entry) {
  const tags = entry.tags?.length ? ` [${entry.tags.join(', ')}]` : '';
  return `${entry.text}${tags}`;
}

async function storeVector(id, vector) {
  vectors.set(id, vector);
  appendLine(VECTORS_FILE, { id, model: EMBED_MODEL, vector: Array.from(vector) });
}

// Embed entries that are missing vectors (new adds where the API call failed,
// or everything added while no key was configured). Self-healing on search.
// Re-entry guard: concurrent searches must not double-embed the same entries
// (duplicate vectors.jsonl lines + wasted API spend), overlapping calls skip,
// and the next search picks up whatever is still missing.
let backfillRunning = false;

async function backfillVectors(limit) {
  if (!semanticAvailable() || backfillRunning) return;
  backfillRunning = true;
  try {
    const missing = [...entries.values()].filter(e => !vectors.has(e.id)).slice(0, limit);
    if (!missing.length) return;
    for (let i = 0; i < missing.length; i += EMBED_BATCH_MAX) {
      const batch = missing.slice(i, i + EMBED_BATCH_MAX);
      const vecs = await embed(batch.map(embeddableText));
      for (let j = 0; j < batch.length; j++) await storeVector(batch[j].id, vecs[j]);
    }
  } finally {
    backfillRunning = false;
  }
}

// ─── Scoring ──────────────────────────────────────────────────────────────────

export function cosine(a, b) {
  if (a.length !== b.length) return 0; // dimension mismatch (e.g. model change) must not produce a silent garbage score
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function terms(text) {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) || []);
}

// Fraction of query terms present in the entry text/tags. Exact substring
// match so identifiers (parcel ids, route names) always hit.
export function keywordScore(query, entry) {
  const qs = [...new Set(terms(query))];
  if (!qs.length) return 0;
  const hay = `${entry.text} ${(entry.tags || []).join(' ')}`.toLowerCase();
  let hit = 0;
  for (const t of qs) if (hay.includes(t)) hit++;
  return hit / qs.length;
}

// ─── Memory operations ────────────────────────────────────────────────────────

function validateText(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('text required');
  if (text.length > MAX_TEXT_LEN) throw new Error(`text exceeds ${MAX_TEXT_LEN} chars`);
  return text.trim();
}

/**
 * Add a memory. Anyone may add; non-Helm submissions land in the inbox for
 * curation. Embedding failures are non-fatal, the entry is saved and the
 * vector is backfilled on a later search.
 */
export async function addMemory({ text, tags = [], team = null, source = null, status = 'inbox' }) {
  const entry = {
    id: uid(),
    text: validateText(text),
    tags: Array.isArray(tags) ? tags.map(String).slice(0, 10) : [],
    team,
    source,                       // { peer_id, agent_name, team_id } | null
    status,                       // 'inbox' | 'curated'
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  entries.set(entry.id, entry);
  appendLine(JOURNAL_FILE, { op: 'add', at: entry.created_at, entry });

  let semantic = false;
  if (semanticAvailable()) {
    try {
      const [vec] = await embed([embeddableText(entry)]);
      await storeVector(entry.id, vec);
      semantic = true;
    } catch (err) {
      console.error(`[helm-memory] embed failed for ${entry.id} (will backfill): ${err.message}`);
    }
  }
  return { entry, semantic };
}

export function updateMemory(id, patch) {
  const cur = entries.get(id);
  if (!cur) throw new Error(`no memory ${id}`);
  const allowed = {};
  if (patch.text !== undefined) allowed.text = validateText(patch.text);
  if (patch.tags !== undefined) allowed.tags = Array.isArray(patch.tags) ? patch.tags.map(String).slice(0, 10) : cur.tags;
  if (patch.team !== undefined) allowed.team = patch.team;
  if (patch.status !== undefined) {
    if (!['inbox', 'curated'].includes(patch.status)) throw new Error('bad status');
    allowed.status = patch.status;
  }
  const at = nowIso();
  const next = { ...cur, ...allowed, updated_at: at };
  entries.set(id, next);
  appendLine(JOURNAL_FILE, { op: 'update', at, id, patch: allowed });
  if (allowed.text !== undefined) vectors.delete(id); // stale vector; backfill re-embeds
  return next;
}

export function deleteMemory(id) {
  if (!entries.has(id)) throw new Error(`no memory ${id}`);
  entries.delete(id);
  vectors.delete(id);
  appendLine(JOURNAL_FILE, { op: 'delete', at: nowIso(), id });
  return { ok: true };
}

export function inbox() {
  return [...entries.values()]
    .filter(e => e.status === 'inbox')
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function stats() {
  const all = [...entries.values()];
  return {
    total: all.length,
    curated: all.filter(e => e.status === 'curated').length,
    inbox: all.filter(e => e.status === 'inbox').length,
    embedded: vectors.size,
    semantic: semanticAvailable(),
  };
}

/**
 * Hybrid search over all live entries (inbox + curated, both are knowledge).
 * Semantic when a key is configured, keyword-only otherwise, the response
 * says which, so callers never mistake degraded recall for full recall.
 *
 * Visibility: entries with team=null are "shared" (published by the Helm).
 *   all: true   , the Helm: everything, no filter
 *   team        , a team: its own entries + anything shared
 *   (neither)   , unidentified callers: shared entries only
 */
export async function search(query, { k = 8, team = null, all = false } = {}) {
  if (typeof query !== 'string' || !query.trim()) throw new Error('query required');
  const useSemantic = semanticAvailable();

  let qVec = null;
  if (useSemantic) {
    try {
      await backfillVectors(BACKFILL_PER_SEARCH);
      [qVec] = await embed([query]);
    } catch (err) {
      console.error(`[helm-memory] semantic search degraded to keyword: ${err.message}`);
      qVec = null;
    }
  }

  let pool = [...entries.values()];
  if (!all) {
    pool = pool.filter(e => !e.team || (team && e.team === team));
  }

  const scored = pool.map(e => {
    const kw = keywordScore(query, e);
    const vec = qVec && vectors.get(e.id);
    const sem = vec ? cosine(qVec, vec) : null;
    const score = sem === null ? kw : SEMANTIC_WEIGHT * sem + KEYWORD_WEIGHT * kw;
    return { entry: e, score, semantic: sem !== null };
  });

  scored.sort((a, b) => b.score - a.score);
  const results = scored
    .filter(s => (qVec ? s.score > 0.1 : s.score > 0))
    .slice(0, Math.min(k, 50));

  return { results, semantic: !!qVec };
}

// Test hook: wipe in-memory state so tests can re-init against a fresh HELM_HOME.
export function _resetForTests() {
  entries.clear();
  vectors.clear();
  initialized = false;
}
