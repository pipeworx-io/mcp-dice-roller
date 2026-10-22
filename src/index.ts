interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * chance.ts — the shared randomization engine for the chance-pack family
 * (dice-roller, tarot, i-ching, creative-constraints, random-tables).
 * Spec: docs/chance-packs-plan.md, "The shared engine".
 *
 * THE SIGNATURES BELOW ARE A CONTRACT. Five packs were written against them
 * before this file existed; renaming or reshaping an export breaks them all.
 * Add exports freely, change none.
 *
 * Three properties every caller relies on:
 *
 *  1. Real randomness by default. `makeRng()` with no seed draws 128 bits from
 *     `crypto.getRandomValues` and RETURNS them as `rng.seed` (32 hex chars).
 *  2. Reproducible on demand. `makeRng(seed)` is a pure function of the seed
 *     string: cyrb128 hashes it to four 32-bit words, which seed sfc32. The
 *     unseeded path runs through the same function with the generated hex, so
 *     the returned seed reproduces that exact call.
 *  3. Stable across releases. The sequence for a given seed is PINNED in
 *     __tests__/chance.test.ts. Changing a constant here re-deals every seeded
 *     result anyone has ever cited — that test is meant to go red when you do.
 *
 * Zero third-party dependencies, no module-scope state, no I/O except the
 * optional KV handed to the session functions. Safe in Workers and Node 19+.
 */

// ── PRNG ────────────────────────────────────────────────────────────────────

type Rng = {
  seed: string;                       // always set; pass it back to reproduce
  next(): number;                     // [0,1)
  int(min: number, max: number): number;   // inclusive
  pick<T>(items: readonly T[]): T;
  shuffle<T>(items: readonly T[]): T[];    // Fisher–Yates, returns a copy
};

/** Longest seed string accepted. A seed is a citation handle, not a payload. */
const MAX_SEED_LENGTH = 256;

/** cyrb128 (bryc, public domain): string → four 32-bit words. */
function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/** sfc32 (Chris Doty-Humphrey, public domain): four words → uint32 stream. */
function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a |= 0; b |= 0; c |= 0; d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
}

/** Outputs discarded after seeding so near-identical seeds decorrelate. */
const SFC32_WARMUP = 15;

/** 128 bits from the platform CSPRNG, hex-encoded (32 chars). */
function randomSeed(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function normalizeSeed(seed: unknown): string | undefined {
  if (seed === undefined || seed === null) return undefined;
  if (typeof seed === 'number' && Number.isFinite(seed)) seed = String(seed);
  if (typeof seed !== 'string') {
    throw new Error(`seed must be a string (got ${typeof seed}). Omit it for a fresh random draw; pass the returned seed back to reproduce one.`);
  }
  if (seed.length === 0) return undefined;
  if (seed.length > MAX_SEED_LENGTH) {
    throw new Error(`seed is ${seed.length} characters; the limit is ${MAX_SEED_LENGTH}.`);
  }
  return seed;
}

// seed omitted → 128 bits from crypto.getRandomValues, hex-encoded, RETURNED as
// rng.seed. seed given → deterministic (hash the string, e.g. cyrb128 → sfc32).
function makeRng(seed?: string): Rng {
  const s = normalizeSeed(seed) ?? randomSeed();
  const [a, b, c, d] = cyrb128(s);
  const u32 = sfc32(a, b, c, d);
  for (let i = 0; i < SFC32_WARMUP; i++) u32();

  const next = (): number => u32() / 4294967296;

  const int = (min: number, max: number): number => {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) {
      throw new Error(`rng.int needs integer bounds (got ${min}, ${max}).`);
    }
    if (min > max) throw new Error(`rng.int: min ${min} is greater than max ${max}.`);
    const range = max - min + 1;
    if (range <= 4294967296) {
      // Rejection sampling: no modulo bias at any range.
      const limit = 4294967296 - (4294967296 % range);
      let x = u32();
      while (x >= limit) x = u32();
      return min + (x % range);
    }
    // Ranges wider than 2^32: 53 bits from two draws.
    const hi = u32() >>> 5, lo = u32() >>> 6;
    const f = (hi * 67108864 + lo) / 9007199254740992;
    return min + Math.floor(f * range);
  };

  const pick = <T>(items: readonly T[]): T => {
    if (!items || items.length === 0) throw new Error('rng.pick: nothing to pick from (empty list).');
    return items[int(0, items.length - 1)];
  };

  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(0, i);
      const tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  };

  return { seed: s, next, int, pick, shuffle };
}

// ── draws ───────────────────────────────────────────────────────────────────

function drawWithoutReplacement<T>(items: readonly T[], n: number, rng: Rng): T[] {
  if (!Number.isInteger(n) || n < 0) throw new Error(`draw count must be a whole number ≥ 0 (got ${n}).`);
  if (n > items.length) {
    throw new Error(`cannot draw ${n} without replacement from ${items.length} item(s); draw at most ${items.length}.`);
  }
  // Partial Fisher–Yates: only the first n positions are settled.
  const pool = items.slice();
  for (let i = 0; i < n; i++) {
    const j = rng.int(i, pool.length - 1);
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return pool.slice(0, n);
}

type WeightedEntry<T> = { value: T; weight?: number };   // weight default 1, must be > 0

function rollWeighted<T>(entries: readonly WeightedEntry<T>[], rng: Rng): { value: T; index: number } {
  if (!entries || entries.length === 0) throw new Error('rollWeighted: the table is empty.');
  let total = 0;
  const weights = entries.map((e, i) => {
    const w = e.weight === undefined ? 1 : e.weight;
    if (typeof w !== 'number' || !Number.isFinite(w) || w <= 0) {
      throw new Error(`rollWeighted: entry ${i} has weight ${String(w)}; weights must be finite numbers > 0 (default 1).`);
    }
    total += w;
    return w;
  });
  let r = rng.next() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return { value: entries[i].value, index: i };
  }
  // Floating-point residue: the last entry owns the top of the range.
  const last = entries.length - 1;
  return { value: entries[last].value, index: last };
}

// ── dice notation ───────────────────────────────────────────────────────────

/** Most dice in one notation (summed across terms, before explosions). */
const MAX_DICE = 1000;
/** Most sides on one die. */
const MAX_SIDES = 10000;
/** Most extra dice one exploding die may add before the chain is cut. */
const MAX_EXPLOSIONS_PER_DIE = 100;
const MAX_TERMS = 50;
const MAX_NOTATION_LENGTH = 200;

type DiceKeep = { mode: 'kh' | 'kl' | 'dh' | 'dl'; count: number };

/** One parsed term. `kind:'constant'` carries only `value`; dice terms carry the rest. */
type DiceTerm = {
  sign: 1 | -1;
  text: string;            // the term as written, normalized, without its sign
  kind: 'dice' | 'constant';
  count: number;           // dice in the term (0 for a constant)
  sides: number;           // 3 for fudge (faces −1, 0, +1); 0 for a constant
  fudge: boolean;
  explode: boolean;
  keep?: DiceKeep;
  value: number;           // constant value (0 for dice)
};

type ParsedDice = { notation: string; terms: DiceTerm[]; dice: number };

const DICE_GRAMMAR =
  'NdS terms joined by + or - (e.g. 2d6+1d4+3). N defaults to 1; S is a number, % (=100) or F (fudge: -1/0/+1). ' +
  'Optional modifiers, in this order: ! (exploding: a max face rolls again), then kh/kl/dh/dl with an optional count ' +
  '(keep highest / keep lowest / drop highest / drop lowest; k alone means kh). Examples: 4d6kh3, 2d20kl1, d%, 4dF, 3d6!, 1d20+5.';

const TERM_RE = /^(\d*)d(\d+|%|f)(!)?(?:(kh|kl|dh|dl|k)(\d+)?)?$/;

function diceError(notation: string, why: string): Error {
  return new Error(`Cannot read dice notation ${JSON.stringify(notation)}: ${why}. Grammar: ${DICE_GRAMMAR}`);
}

/** Parse without rolling. Throws a plain-English error naming the grammar on anything malformed or over the limits. */
function parseDiceNotation(notation: string): ParsedDice {
  if (typeof notation !== 'string') throw diceError(String(notation), 'notation must be a string');
  const raw = notation;
  const s = notation.replace(/\s+/g, '').toLowerCase();
  if (s.length === 0) throw diceError(raw, 'it is empty');
  if (s.length > MAX_NOTATION_LENGTH) throw diceError(raw.slice(0, 40) + '…', `it is longer than ${MAX_NOTATION_LENGTH} characters`);

  const parts: Array<{ sign: 1 | -1; body: string }> = [];
  let i = 0;
  let sign: 1 | -1 = 1;
  if (s[0] === '+' || s[0] === '-') { sign = s[0] === '-' ? -1 : 1; i = 1; }
  let start = i;
  for (; i <= s.length; i++) {
    const ch = s[i];
    if (i === s.length || ch === '+' || ch === '-') {
      const body = s.slice(start, i);
      if (body.length === 0) throw diceError(raw, 'there is an empty term (two operators in a row, or a trailing operator)');
      parts.push({ sign, body });
      if (i < s.length) sign = ch === '-' ? -1 : 1;
      start = i + 1;
    }
  }
  if (parts.length > MAX_TERMS) throw diceError(raw, `it has ${parts.length} terms; the limit is ${MAX_TERMS}`);

  let dice = 0;
  let hasDice = false;
  const terms: DiceTerm[] = parts.map(({ sign: sg, body }) => {
    if (/^\d+$/.test(body)) {
      const value = Number(body);
      if (!Number.isSafeInteger(value)) throw diceError(raw, `the constant ${body} is too large`);
      return { sign: sg, text: body, kind: 'constant', count: 0, sides: 0, fudge: false, explode: false, value };
    }
    const m = TERM_RE.exec(body);
    // Fudge is conventionally written with a capital F; show it that way.
    const text = body.replace(/df/, 'dF');
    if (!m) throw diceError(raw, `the term "${body}" is not NdS with optional ! and kh/kl/dh/dl`);
    const count = m[1] === '' ? 1 : Number(m[1]);
    const fudge = m[2] === 'f';
    const sides = fudge ? 3 : m[2] === '%' ? 100 : Number(m[2]);
    const explode = m[3] === '!';
    if (count < 1) throw diceError(raw, `"${body}" rolls zero dice`);
    if (!fudge && sides < 1) throw diceError(raw, `"${body}" has a zero-sided die`);
    if (!fudge && sides > MAX_SIDES) throw diceError(raw, `"${body}" has ${sides} sides; the limit is ${MAX_SIDES}`);
    if (explode && fudge) throw diceError(raw, `"${text}": fudge dice cannot explode`);
    if (explode && sides === 1) throw diceError(raw, `"${body}": a one-sided die always shows its max, so it would explode forever`);
    let keep: DiceKeep | undefined;
    if (m[4]) {
      const mode = (m[4] === 'k' ? 'kh' : m[4]) as DiceKeep['mode'];
      const n = m[5] === undefined ? 1 : Number(m[5]);
      if (n < 1) throw diceError(raw, `"${body}" keeps or drops zero dice`);
      if (mode === 'kh' || mode === 'kl') {
        if (n > count) throw diceError(raw, `"${body}" keeps ${n} of only ${count} dice`);
      } else if (n >= count) {
        throw diceError(raw, `"${body}" drops ${n} of only ${count} dice, leaving none`);
      }
      keep = { mode, count: n };
    }
    dice += count;
    hasDice = true;
    if (dice > MAX_DICE) throw diceError(raw, `it rolls more than ${MAX_DICE} dice`);
    return { sign: sg, text, kind: 'dice', count, sides, fudge, explode, keep, value: 0 };
  });
  if (!hasDice) throw diceError(raw, 'it has no dice term (a bare number is not a roll)');

  const normalized = terms
    .map((t, idx) => (t.sign < 0 ? '-' : idx === 0 ? '' : '+') + t.text)
    .join('');
  return { notation: normalized, terms, dice };
}

/** Indices (into `values`) that a keep/drop rule retains. Ties break by position, so it is deterministic. */
function keptIndices(values: readonly number[], keep: DiceKeep | undefined): number[] {
  const all = values.map((_, i) => i);
  if (!keep) return all;
  const asc = all.slice().sort((x, y) => values[x] - values[y] || x - y);
  const n = keep.count;
  let chosen: number[] = all;
  switch (keep.mode) {
    case 'kh': chosen = asc.slice(asc.length - Math.min(n, asc.length)); break;
    case 'kl': chosen = asc.slice(0, Math.min(n, asc.length)); break;
    case 'dh': chosen = asc.slice(0, Math.max(0, asc.length - n)); break;
    case 'dl': chosen = asc.slice(Math.min(n, asc.length)); break;
  }
  return chosen.sort((x, y) => x - y);
}

/** Roll one parsed dice term: the individual dice (explosions appended after the die that caused them) and the kept ones. */
function rollDiceTerm(term: DiceTerm, rng: Rng): { rolls: number[]; kept: number[] } {
  if (term.kind === 'constant') return { rolls: [], kept: [] };
  const rolls: number[] = [];
  for (let d = 0; d < term.count; d++) {
    let face = term.fudge ? rng.int(-1, 1) : rng.int(1, term.sides);
    rolls.push(face);
    let chain = 0;
    while (term.explode && face === term.sides && chain < MAX_EXPLOSIONS_PER_DIE) {
      face = rng.int(1, term.sides);
      rolls.push(face);
      chain++;
    }
  }
  const idx = keptIndices(rolls, term.keep);
  return { rolls, kept: idx.map((i) => rolls[i]) };
}

// Dice notation: NdS, modifiers (+/-), multiple terms (2d6+1d4+3), keep/drop
// (4d6kh3, 2d20kl1, dl/dh), exploding (d6!), fudge (4dF), percentile (d%/d100).
// Refuse >1000 dice or >10000 sides with a plain error. `detail` is human-readable.
type DiceResult = { notation: string; total: number; terms: Array<{ term: string; rolls: number[]; kept: number[]; subtotal: number }>; detail: string };

function rollDice(notation: string, rng: Rng): DiceResult {
  const parsed = parseDiceNotation(notation);
  let total = 0;
  const pieces: string[] = [];
  const terms = parsed.terms.map((t, idx) => {
    const signText = t.sign < 0 ? '-' : idx === 0 ? '' : '+';
    if (t.kind === 'constant') {
      const subtotal = t.sign * t.value;
      total += subtotal;
      pieces.push(`${signText}${t.value}`);
      return { term: `${signText}${t.text}`, rolls: [], kept: [], subtotal };
    }
    const { rolls, kept } = rollDiceTerm(t, rng);
    const sum = kept.reduce((a, b) => a + b, 0);
    const subtotal = t.sign * sum;
    total += subtotal;
    const fmt = (v: number) => (t.fudge ? (v > 0 ? '+' : v < 0 ? '-' : '0') : String(v));
    const keptSet = new Set(keptIndices(rolls, t.keep));
    const shown = rolls.map((v, i) => (keptSet.has(i) ? fmt(v) : `(${fmt(v)} dropped)`)).join(', ');
    pieces.push(`${signText}${t.text} [${shown}] = ${sum}`);
    return { term: `${signText}${t.text}`, rolls, kept, subtotal };
  });
  // `-0` is a legal sum of fudge dice; normalise so JSON shows 0.
  if (Object.is(total, -0)) total = 0;
  return { notation: parsed.notation, total, terms, detail: `${pieces.join(' ')} → total ${total}` };
}

// ── sessions: draw without replacement ACROSS calls ─────────────────────────
//
// Backed by the gateway's KV (`injectCacheKv: true` on the manifest row →
// `args._cacheKv`), key `chance:session:<id>`, TTL 24 h. Hosted-only: with no
// KV every function returns SessionUnsupported instead of throwing, and a
// seeded single-call draw still works.
//
// KV is eventually consistent and has no compare-and-swap, so two draws on the
// SAME session racing within the same second can both read the old position.
// Sessions are a convenience for one agent drawing in sequence, not a ledger.

/** The `{ get, put }` shape mcps/web-fetch uses; Cloudflare's KVNamespace satisfies it. */
interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

type SessionUnsupported = { session_supported: false; hint: string };
type SessionNotFound = { session_supported: true; session_found: false; session_id: string; hint: string };
// A successful DeckSession never carries `session_supported` or `session_found`:
// test `session_supported === false` for "no KV here", `session_found === false`
// for "no such session", and treat anything else as the session.

type DeckSession = { session_id: string; deck_id: string; deck_version: string; seed: string; order: number[]; position: number; created_at: string; expires_at: string };

const SESSION_KEY_PREFIX = 'chance:session:';
const SESSION_TTL_SECONDS = 86400;
/** Largest deck a session will hold (the order array is stored whole). */
const MAX_SESSION_DECK_SIZE = 10000;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const SESSION_UNSUPPORTED_HINT =
  'Deck sessions (drawing without replacement across calls) work only through the Pipeworx gateway; this standalone build has no session support. ' +
  'Single-call draws still work: pass `seed` to make one reproducible, and draw several items in one call to avoid repeats.';

function unsupported(): SessionUnsupported {
  return { session_supported: false, hint: SESSION_UNSUPPORTED_HINT };
}

function notFound(sessionId: string): SessionNotFound {
  return {
    session_supported: true,
    session_found: false,
    session_id: sessionId,
    hint: 'No such session: it never existed, or it expired (sessions last 24 hours from their last shuffle). Open a new one.',
  };
}

function isSessionUnsupported(x: unknown): x is SessionUnsupported {
  return typeof x === 'object' && x !== null && (x as { session_supported?: unknown }).session_supported === false;
}

function isSessionNotFound(x: unknown): x is SessionNotFound {
  return typeof x === 'object' && x !== null && (x as { session_found?: unknown }).session_found === false;
}

function usableKv(kv: KvLike | null | undefined): kv is KvLike {
  return !!kv && typeof kv.get === 'function' && typeof kv.put === 'function';
}

function sessionKey(id: string): string {
  return SESSION_KEY_PREFIX + id;
}

function checkSessionId(id: unknown): string {
  if (typeof id !== 'string' || !SESSION_ID_RE.test(id)) {
    throw new Error(`session_id must be the id a previous call returned (letters, digits, - and _; got ${JSON.stringify(id)}).`);
  }
  return id;
}

function newSessionId(): string {
  return 'cs_' + randomSeed().slice(0, 24);
}

async function writeSession(kv: KvLike, s: DeckSession, nowMs: number): Promise<void> {
  // KV's floor is 60 s; keep the session's own expiry rather than extending it on every draw.
  const ttl = Math.max(60, Math.ceil((Date.parse(s.expires_at) - nowMs) / 1000));
  await kv.put(sessionKey(s.session_id), JSON.stringify(s), { expirationTtl: ttl });
}

async function readSession(kv: KvLike, id: string, nowMs: number): Promise<DeckSession | null> {
  const raw = await kv.get(sessionKey(id));
  if (!raw) return null;
  let s: DeckSession;
  try {
    s = JSON.parse(raw) as DeckSession;
  } catch {
    return null;
  }
  if (!s || !Array.isArray(s.order) || typeof s.position !== 'number') return null;
  if (Date.parse(s.expires_at) <= nowMs) return null;
  return s;
}

function shuffledOrder(size: number, rng: Rng): number[] {
  const base = Array.from({ length: size }, (_, i) => i);
  return rng.shuffle(base);
}

async function openSession(kv: KvLike | null, deck: { id: string; version: string; size: number }, seed?: string): Promise<DeckSession | SessionUnsupported> {
  if (!deck || typeof deck.id !== 'string' || deck.id.length === 0 || typeof deck.version !== 'string') {
    throw new Error('openSession: deck needs a string id and version.');
  }
  if (!Number.isInteger(deck.size) || deck.size < 1 || deck.size > MAX_SESSION_DECK_SIZE) {
    throw new Error(`openSession: deck size must be a whole number from 1 to ${MAX_SESSION_DECK_SIZE} (got ${deck.size}).`);
  }
  if (!usableKv(kv)) return unsupported();
  const rng = makeRng(seed);
  const now = Date.now();
  const session: DeckSession = {
    session_id: newSessionId(),
    deck_id: deck.id,
    deck_version: deck.version,
    seed: rng.seed,
    order: shuffledOrder(deck.size, rng),
    position: 0,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + SESSION_TTL_SECONDS * 1000).toISOString(),
  };
  await writeSession(kv, session, now);
  return session;
}

async function drawFromSession(kv: KvLike | null, sessionId: string, n: number): Promise<{ indices: number[]; remaining: number; session: DeckSession } | SessionUnsupported | SessionNotFound> {
  if (!usableKv(kv)) return unsupported();
  const id = checkSessionId(sessionId);
  if (!Number.isInteger(n) || n < 1) throw new Error(`draw count must be a whole number ≥ 1 (got ${n}).`);
  const now = Date.now();
  const s = await readSession(kv, id, now);
  if (!s) return notFound(id);
  const remaining = s.order.length - s.position;
  if (remaining === 0) {
    throw new Error(`session ${id} is exhausted: all ${s.order.length} items of deck "${s.deck_id}" have been drawn. Reshuffle it, or open a new session.`);
  }
  if (n > remaining) {
    throw new Error(`session ${id} has only ${remaining} of ${s.order.length} items left; draw at most ${remaining}, or reshuffle.`);
  }
  const indices = s.order.slice(s.position, s.position + n);
  const updated: DeckSession = { ...s, position: s.position + n };
  await writeSession(kv, updated, now);
  return { indices, remaining: updated.order.length - updated.position, session: updated };
}

async function reshuffleSession(kv: KvLike | null, sessionId: string, seed?: string): Promise<DeckSession | SessionUnsupported | SessionNotFound> {
  if (!usableKv(kv)) return unsupported();
  const id = checkSessionId(sessionId);
  const now = Date.now();
  const s = await readSession(kv, id, now);
  if (!s) return notFound(id);
  const rng = makeRng(seed);
  const updated: DeckSession = {
    ...s,
    seed: rng.seed,
    order: shuffledOrder(s.order.length, rng),
    position: 0,
    expires_at: new Date(now + SESSION_TTL_SECONDS * 1000).toISOString(),
  };
  await writeSession(kv, updated, now);
  return updated;
}

// ── response envelope ───────────────────────────────────────────────────────

// Every pack response carries this envelope so the caller can reproduce and cite.
type ChanceMeta = { seed: string; procedure: string; deck: { id: string; version: string }; session_id?: string; data_as_of?: string; source: string };
/**
 * dice-roller — tabletop dice, coin flips and exact dice odds on the Pipeworx
 * chance engine (shared/src/chance.ts; plan: docs/chance-packs-plan.md).
 *
 * Keyless, no upstream, no outbound calls. Every roll comes from the engine's
 * seeded generator: omit `seed` for a fresh random result, pass the returned
 * `seed` back to reproduce it exactly. The slug is `dice-roller` because
 * `dice` is the dice.fm event-listings pack.
 *
 * The results are random outcomes, not advice: the calling agent decides what
 * a roll means.
 */


const SOURCE =
  'Pipeworx dice engine v1: sfc32 pseudo-random generator seeded from a cyrb128 hash of the seed; ' +
  'an unseeded call draws a 128-bit seed from the platform cryptographic random source and returns it';

const DICE_DECK = { id: 'polyhedral-dice', version: '1' };
const COIN_DECK = { id: 'fair-coin', version: '1' };

const MAX_TIMES = 100;
const MAX_FLIPS = 1000;
/** Monte Carlo sample count when the budget allows (spec: 100k). */
const MC_SAMPLES = 100000;
/** Total dice-rolls one Monte Carlo run may spend; big pools get fewer samples, and say so. */
const MC_DIE_BUDGET = 5_000_000;
/** Largest keep/drop term enumerated outcome-by-outcome (sides^count). */
const MAX_KEEP_ENUMERATION = 1_000_000;
/** Rough cap on convolution work for plain sums. */
const MAX_CONVOLUTION_OPS = 20_000_000;
/** Distributions with more distinct totals than this are summarized by percentiles instead of listed. */
const MAX_LISTED_TOTALS = 201;

const COMPARISONS = ['>=', '>', '<=', '<', '=='] as const;
type Comparison = (typeof COMPARISONS)[number];

const tools: McpToolExport['tools'] = [
  {
    name: 'roll_dice',
    description: 'Pipeworx dice engine: roll tabletop dice notation with real randomness — NdS terms joined by + or - (2d6+1d4+3, 1d20-2), keep/drop (4d6kh3, 2d20kl1 for disadvantage, 4d6dl1), exploding dice (3d6!), fudge/Fate dice (4dF) and percentile (d% or d100). Up to 1,000 dice and 10,000 sides. Returns every die rolled, which dice were kept, per-term subtotals, the total and a readable breakdown; `times` repeats the roll (up to 100) and adds min/max/mean. Omit `seed` for a fresh roll; pass the returned `seed` to reproduce it exactly. The outcome is random — the calling agent decides what it means.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        notation: { type: 'string', description: 'Dice notation, e.g. "2d6+3", "4d6kh3", "2d20kl1", "d%", "4dF", "3d6!".' },
        times: { type: 'integer', minimum: 1, maximum: 100, description: 'How many times to roll the whole notation (default 1, max 100).' },
        seed: { type: 'string', description: 'Optional seed. Same seed + same arguments = same result. Omit for a fresh random roll; the seed used is always returned.' },
      },
      required: ['notation'],
    },
  },
  {
    name: 'flip_coins',
    description: 'Pipeworx dice engine: flip fair coins with real randomness — up to 1,000 per call. Returns the sequence (H/T), heads and tails counts, and the longest run. Omit `seed` for fresh flips; pass the returned `seed` to reproduce them exactly. The outcome is random — the calling agent decides what it means.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 1000, description: 'Number of coins to flip (default 1, max 1000).' },
        seed: { type: 'string', description: 'Optional seed. Same seed + same count = same flips. Omit for fresh flips; the seed used is always returned.' },
      },
    },
  },
  {
    name: 'dice_odds',
    description: 'Pipeworx dice engine: the probability distribution of a dice notation (same grammar as roll_dice: 2d6+3, 4d6kh3, 2d20kl1, 4dF, 3d6!) — min, max, mean, standard deviation, mode, the probability of every total and, given `target`, the chance the total is >=, >, <=, < or == that target (e.g. "what are the odds of 15 or more on 3d6"). Exact by enumeration where the outcomes can be enumerated (plain sums, and keep/drop pools up to 1,000,000 outcomes); otherwise a 100,000-sample Monte Carlo estimate labelled method:"monte_carlo" (exploding dice always use it). `seed` makes a Monte Carlo estimate reproducible.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        notation: { type: 'string', description: 'Dice notation, e.g. "3d6", "4d6kh3", "2d20kh1+5".' },
        target: { type: 'number', description: 'Optional target total to compute a probability for.' },
        comparison: { type: 'string', enum: ['>=', '>', '<=', '<', '=='], description: 'How the total is compared with target (default ">=").' },
        seed: { type: 'string', description: 'Optional seed for the Monte Carlo path; exact results ignore it. Always returned.' },
      },
      required: ['notation'],
    },
  },
];

// ── helpers ─────────────────────────────────────────────────────────────────

function meta(seed: string, procedure: string, deck: { id: string; version: string }): ChanceMeta {
  return { seed, procedure, deck, source: SOURCE };
}

function requireNotation(args: Record<string, unknown>): string {
  const n = args.notation;
  if (typeof n !== 'string' || n.trim() === '') {
    throw new Error(`notation is required — a dice expression such as "2d6+3". Grammar: ${DICE_GRAMMAR}`);
  }
  return n;
}

function boundedInt(v: unknown, name: string, dflt: number, min: number, max: number): number {
  if (v === undefined || v === null || v === '') return dflt;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max} (got ${JSON.stringify(v)}).`);
  }
  return n;
}

function seedArg(args: Record<string, unknown>): string | undefined {
  const s = args.seed;
  if (s === undefined || s === null) return undefined;
  if (typeof s === 'number' && Number.isFinite(s)) return String(s);
  if (typeof s !== 'string') throw new Error(`seed must be a string (got ${typeof s}).`);
  return s;
}

const round = (x: number, dp = 6) => Number(x.toFixed(dp));

// ── roll_dice ───────────────────────────────────────────────────────────────

function rollDiceTool(args: Record<string, unknown>) {
  const notation = requireNotation(args);
  const times = boundedInt(args.times, 'times', 1, 1, MAX_TIMES);
  const rng = makeRng(seedArg(args));
  const rolls: DiceResult[] = [];
  for (let i = 0; i < times; i++) rolls.push(rollDice(notation, rng));
  const totals = rolls.map((r) => r.total);
  const sum = totals.reduce((a, b) => a + b, 0);
  const procedure =
    `Parsed "${rolls[0].notation}" and rolled it ${times} time${times === 1 ? '' : 's'} from one seeded stream: ` +
    'each die is an unbiased integer draw (rejection sampling); exploding dice add a die after each max face; ' +
    'keep/drop rules then select which dice count.';
  const out: Record<string, unknown> = {
    notation: rolls[0].notation,
    times,
    total: sum,
  };
  if (times === 1) {
    out.terms = rolls[0].terms;
    out.detail = rolls[0].detail;
  } else {
    out.totals = totals;
    out.min = Math.min(...totals);
    out.max = Math.max(...totals);
    out.mean = round(sum / times, 4);
  }
  out.rolls = rolls;
  out.seed = rng.seed;
  out.meta = meta(rng.seed, procedure, DICE_DECK);
  return out;
}

// ── flip_coins ──────────────────────────────────────────────────────────────

function flipCoinsTool(args: Record<string, unknown>) {
  const count = boundedInt(args.count, 'count', 1, 1, MAX_FLIPS);
  const rng = makeRng(seedArg(args));
  let seq = '';
  let heads = 0;
  let best = { side: 'heads' as 'heads' | 'tails', length: 0 };
  let run = 0;
  let prev = '';
  for (let i = 0; i < count; i++) {
    const c = rng.int(0, 1) === 0 ? 'H' : 'T';
    seq += c;
    if (c === 'H') heads++;
    run = c === prev ? run + 1 : 1;
    prev = c;
    if (run > best.length) best = { side: c === 'H' ? 'heads' : 'tails', length: run };
  }
  return {
    count,
    sequence: seq,
    heads,
    tails: count - heads,
    longest_run: best,
    seed: rng.seed,
    meta: meta(rng.seed, `Flipped ${count} fair coin${count === 1 ? '' : 's'}: each flip is an unbiased draw of 0 (H) or 1 (T) from one seeded stream.`, COIN_DECK),
  };
}

// ── dice_odds ───────────────────────────────────────────────────────────────

type Dist = Map<number, number>;

function convolve(a: Dist, b: Dist): Dist {
  const out: Dist = new Map();
  for (const [x, px] of a) for (const [y, py] of b) out.set(x + y, (out.get(x + y) ?? 0) + px * py);
  return out;
}

function faceValues(t: DiceTerm): number[] {
  return t.fudge ? [-1, 0, 1] : Array.from({ length: t.sides }, (_, i) => i + 1);
}

/** Exact distribution of one term, or null when it cannot be enumerated within budget. */
function exactTerm(t: DiceTerm): Dist | null {
  if (t.kind === 'constant') return new Map([[t.sign * t.value, 1]]);
  if (t.explode) return null;
  const faces = faceValues(t);
  const pFace = 1 / faces.length;
  let dist: Dist;
  if (!t.keep) {
    // Plain sum: repeated convolution. Estimate the work first.
    const k = faces.length;
    const ops = (t.count * t.count * k * k) / 2;
    if (ops > MAX_CONVOLUTION_OPS) return null;
    const die: Dist = new Map(faces.map((f) => [f, pFace]));
    dist = new Map([[0, 1]]);
    for (let i = 0; i < t.count; i++) dist = convolve(dist, die);
  } else {
    if (Math.pow(faces.length, t.count) > MAX_KEEP_ENUMERATION) return null;
    // Odometer over every ordered outcome; each has probability (1/k)^count.
    const p = Math.pow(pFace, t.count);
    const idx = new Array(t.count).fill(0);
    const vals = new Array(t.count).fill(faces[0]);
    dist = new Map();
    for (;;) {
      const kept = keptIndices(vals, t.keep);
      let s = 0;
      for (const i of kept) s += vals[i];
      dist.set(s, (dist.get(s) ?? 0) + p);
      let d = 0;
      while (d < t.count) {
        idx[d]++;
        if (idx[d] < faces.length) { vals[d] = faces[idx[d]]; break; }
        idx[d] = 0;
        vals[d] = faces[0];
        d++;
      }
      if (d === t.count) break;
    }
  }
  if (t.sign < 0) {
    const neg: Dist = new Map();
    for (const [x, px] of dist) neg.set(-x, px);
    return neg;
  }
  return dist;
}

function exactDistribution(parsed: ParsedDice): Dist | null {
  let dist: Dist = new Map([[0, 1]]);
  for (const t of parsed.terms) {
    const td = exactTerm(t);
    if (!td) return null;
    dist = convolve(dist, td);
    if (dist.size > 200_001) return null;
  }
  return dist;
}

function monteCarlo(parsed: ParsedDice, seed: string | undefined): { dist: Dist; samples: number; seed: string } {
  const rng = makeRng(seed);
  const perSample = Math.max(1, parsed.dice);
  const samples = Math.max(1000, Math.min(MC_SAMPLES, Math.floor(MC_DIE_BUDGET / perSample)));
  const counts: Dist = new Map();
  for (let s = 0; s < samples; s++) {
    let total = 0;
    for (const t of parsed.terms) {
      if (t.kind === 'constant') { total += t.sign * t.value; continue; }
      const { kept } = rollDiceTerm(t, rng);
      let sum = 0;
      for (const v of kept) sum += v;
      total += t.sign * sum;
    }
    counts.set(total, (counts.get(total) ?? 0) + 1);
  }
  const dist: Dist = new Map();
  for (const [x, c] of counts) dist.set(x, c / samples);
  return { dist, samples, seed: rng.seed };
}

function compare(x: number, op: Comparison, target: number): boolean {
  switch (op) {
    case '>=': return x >= target;
    case '>': return x > target;
    case '<=': return x <= target;
    case '<': return x < target;
    case '==': return x === target;
  }
}

function diceOddsTool(args: Record<string, unknown>) {
  const notation = requireNotation(args);
  const parsed = parseDiceNotation(notation);
  let target: number | undefined;
  if (args.target !== undefined && args.target !== null && args.target !== '') {
    const t = typeof args.target === 'string' ? Number(args.target) : args.target;
    if (typeof t !== 'number' || !Number.isFinite(t)) throw new Error(`target must be a number (got ${JSON.stringify(args.target)}).`);
    target = t;
  }
  let comparison: Comparison = '>=';
  if (args.comparison !== undefined && args.comparison !== null && args.comparison !== '') {
    if (!COMPARISONS.includes(args.comparison as Comparison)) {
      throw new Error(`comparison must be one of ${COMPARISONS.join(', ')} (got ${JSON.stringify(args.comparison)}).`);
    }
    comparison = args.comparison as Comparison;
  }

  const exact = exactDistribution(parsed);
  let dist: Dist;
  let method: 'exact' | 'monte_carlo';
  let samples: number | undefined;
  let seed: string;
  if (exact) {
    dist = exact;
    method = 'exact';
    seed = makeRng(seedArg(args)).seed;
  } else {
    const mc = monteCarlo(parsed, seedArg(args));
    dist = mc.dist;
    method = 'monte_carlo';
    samples = mc.samples;
    seed = mc.seed;
  }

  const totals = [...dist.keys()].sort((a, b) => a - b);
  if (totals.length === 0) throw new Error(`no outcomes computed for "${parsed.notation}" — this is a bug; please report it.`);
  let mean = 0;
  for (const x of totals) mean += x * dist.get(x)!;
  let variance = 0;
  for (const x of totals) variance += (x - mean) ** 2 * dist.get(x)!;
  let mode = totals[0];
  for (const x of totals) if (dist.get(x)! > dist.get(mode)!) mode = x;

  const percentile = (q: number) => {
    let acc = 0;
    for (const x of totals) { acc += dist.get(x)!; if (acc >= q - 1e-12) return x; }
    return totals[totals.length - 1];
  };

  const out: Record<string, unknown> = {
    notation: parsed.notation,
    method,
  };
  if (samples !== undefined) out.samples = samples;
  out.min = totals[0];
  out.max = totals[totals.length - 1];
  if (method === 'monte_carlo') out.min_max_note = 'min and max are the extremes observed in the sample, not the theoretical bounds.';
  out.mean = round(mean, 4);
  out.stddev = round(Math.sqrt(variance), 4);
  out.mode = mode;
  out.median = percentile(0.5);
  if (target !== undefined) {
    let p = 0;
    for (const x of totals) if (compare(x, comparison, target)) p += dist.get(x)!;
    out.target = target;
    out.comparison = comparison;
    out.probability = round(Math.min(1, p), 6);
    out.probability_percent = round(Math.min(1, p) * 100, 3);
  }
  if (totals.length <= MAX_LISTED_TOTALS) {
    out.distribution = totals.map((x) => ({ total: x, probability: round(dist.get(x)!, 8) }));
  } else {
    out.percentiles = { p5: percentile(0.05), p25: percentile(0.25), p50: percentile(0.5), p75: percentile(0.75), p95: percentile(0.95) };
    out.distribution_note = `${totals.length} distinct totals — summarized as percentiles rather than listed. Ask with a target for an exact tail probability.`;
  }
  out.seed = seed;
  out.meta = meta(
    seed,
    method === 'exact'
      ? `Exact: enumerated every outcome of "${parsed.notation}" (convolution for plain sums, outcome-by-outcome for keep/drop pools).`
      : `Monte Carlo: rolled "${parsed.notation}" ${samples} times from one seeded stream and counted totals; probabilities are estimates (standard error ≈ ${round(0.5 / Math.sqrt(samples!), 4)} at worst).`,
    DICE_DECK,
  );
  return out;
}

// ── dispatch ────────────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'roll_dice':
      return rollDiceTool(args ?? {});
    case 'flip_coins':
      return flipCoinsTool(args ?? {});
    case 'dice_odds':
      return diceOddsTool(args ?? {});
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
