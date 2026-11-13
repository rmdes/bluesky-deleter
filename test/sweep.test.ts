import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { XRPCError } from '@atproto/api';
import { fileCheckpoints, type Checkpoints } from '../src/checkpoint.ts';
import { formatDuration, rateLimitWaitMs, retryDelayMs, sweep, type Repo } from '../src/sweep.ts';

const DID = 'did:plc:test';
const DOMAINS = ['example.com'];
const KEY = `${DID}|example.com`;
const NOW_MS = 1_700_000_000_000;
const HOUR_MS = 3_600_000;

interface FakePost {
  rkey: string;
  url?: string;
}

interface FakeRepo {
  repo: Repo;
  remaining: () => string[];
  listCursors: (string | undefined)[];
  deleteCalls: string[][];
}

const toRecord = ({ rkey, url }: FakePost) => ({
  uri: `at://${DID}/app.bsky.feed.post/${rkey}`,
  cid: 'cid',
  value: url ? { text: 'x', facets: [{ features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }] }] } : { text: 'x' },
});

/** In-memory PDS: pages by rkey like the real one; `writeFailures` are thrown by successive applyWrites. */
function fakeRepo(posts: FakePost[], writeFailures: unknown[] = []): FakeRepo {
  const store = new Map(posts.map((post) => [post.rkey, post]));
  const pendingFailures = [...writeFailures];
  const listCursors: (string | undefined)[] = [];
  const deleteCalls: string[][] = [];

  const repo: Repo = {
    listRecords: async (params) => {
      // The real PDS only pages oldest-first over posts when asked exactly this way.
      assert.equal(params?.repo, DID);
      assert.equal(params?.collection, 'app.bsky.feed.post');
      assert.equal(params?.reverse, true);
      listCursors.push(params?.cursor);
      const after = params?.cursor ?? '';
      const page = [...store.values()].filter((post) => post.rkey > after).slice(0, params?.limit);
      return { success: true, headers: {}, data: { records: page.map(toRecord), cursor: page.at(-1)?.rkey } };
    },
    applyWrites: async (input) => {
      const failure = pendingFailures.shift();
      if (failure) throw failure;
      const rkeys = (input?.writes ?? []).map((write) => String(write.rkey));
      rkeys.forEach((rkey) => store.delete(rkey));
      deleteCalls.push(rkeys);
      return { success: true, headers: { 'ratelimit-remaining': '4900' }, data: {} };
    },
  };
  return { repo, remaining: () => [...store.keys()], listCursors, deleteCalls };
}

/** 250 posts over three pages; every third one links to the target domain. */
const makePosts = (): FakePost[] =>
  Array.from({ length: 250 }, (_, index) => ({
    rkey: `r${String(index).padStart(3, '0')}`,
    url: index % 3 === 0 ? `https://www.example.com/${index}` : index % 3 === 1 ? 'https://other.org' : undefined,
  }));

const MATCHING = makePosts().filter((post) => post.url?.includes('example.com')).length;

let dir: string;
let checkpoints: Checkpoints;
let sleeps: number[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sweep-test-'));
  checkpoints = fileCheckpoints(join(dir, 'state.json'));
  sleeps = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (fake: FakeRepo, dryRun = false) =>
  sweep({
    repo: fake.repo,
    did: DID,
    domains: DOMAINS,
    dryRun,
    checkpoints,
    log: () => {},
    sleep: async (ms) => void sleeps.push(ms),
    now: () => NOW_MS,
  });

test('deletes every matching post across pages and leaves the rest', async () => {
  const fake = fakeRepo(makePosts());

  const result = await run(fake);

  assert.equal(result.scanned, 250);
  assert.equal(result.matched, MATCHING);
  assert.equal(fake.remaining().length, 250 - MATCHING);
  assert.equal(fake.deleteCalls.length, 3);
  assert.ok(fake.deleteCalls.every((call) => call.length <= 200));
  assert.equal(checkpoints.load(KEY), undefined);
});

test('dry run deletes nothing and writes no checkpoint', async () => {
  const fake = fakeRepo(makePosts());

  const result = await run(fake, true);

  assert.equal(result.matched, MATCHING);
  assert.equal(fake.remaining().length, 250);
  assert.equal(fake.deleteCalls.length, 0);
  assert.equal(existsSync(join(dir, 'state.json')), false);
});

test('waits until the rate-limit reset, then retries the same batch', async () => {
  const resetSeconds = (NOW_MS + 9 * HOUR_MS) / 1_000;
  const rateLimited = new XRPCError(429, 'RateLimitExceeded', 'Rate Limit Exceeded', {
    'ratelimit-reset': String(resetSeconds),
  });
  const fake = fakeRepo(makePosts(), [rateLimited]);

  const result = await run(fake);

  assert.deepEqual(sleeps, [9 * HOUR_MS + 1_000]);
  assert.equal(result.matched, MATCHING);
  assert.equal(fake.remaining().length, 250 - MATCHING);
});

test('saves a checkpoint per page, so a crash resumes instead of starting over', async () => {
  const crash = new XRPCError(400, 'InvalidRequest', 'boom');
  const fake = fakeRepo(makePosts(), [undefined, crash]);

  await assert.rejects(run(fake), /boom/);
  const saved = checkpoints.load(KEY);
  assert.equal(saved?.cursor, 'r099');
  assert.equal(saved?.scanned, 100);

  const resumed = await run(fake);

  assert.equal(fake.listCursors.at(-3), 'r099');
  assert.equal(resumed.scanned, 250);
  assert.equal(resumed.matched, MATCHING);
  assert.equal(fake.remaining().length, 250 - MATCHING);
  assert.equal(checkpoints.load(KEY), undefined);
});

test('retries transient failures with backoff', async () => {
  const fake = fakeRepo(makePosts(), [new XRPCError(502, 'UpstreamFailure', 'bad gateway')]);

  await run(fake);

  assert.deepEqual(sleeps, [2_000]);
  assert.equal(fake.remaining().length, 250 - MATCHING);
});

test('rate-limit waits do not use up the transient retry allowance', async () => {
  const rateLimited = () => new XRPCError(429, 'RateLimitExceeded', 'Rate Limit Exceeded');
  const failures = [...Array.from({ length: 6 }, rateLimited), new XRPCError(502, 'UpstreamFailure', 'bad gateway')];
  const fake = fakeRepo(makePosts(), failures);

  await run(fake);

  assert.deepEqual(sleeps, [60_000, 60_000, 60_000, 60_000, 60_000, 60_000, 2_000]);
  assert.equal(fake.remaining().length, 250 - MATCHING);
});

test('retryDelayMs gives up on transient errors after the attempt limit', () => {
  const networkDown = new XRPCError(1, 'Unknown', 'fetch failed');
  assert.equal(retryDelayMs(networkDown, 1, NOW_MS), 2_000);
  assert.equal(retryDelayMs(networkDown, 4, NOW_MS), 16_000);
  assert.equal(retryDelayMs(networkDown, 5, NOW_MS), undefined);
});

test('retryDelayMs never retries client errors or unknown throwables', () => {
  assert.equal(retryDelayMs(new XRPCError(400, 'InvalidRequest', 'bad'), 1, NOW_MS), undefined);
  assert.equal(retryDelayMs(new XRPCError(401, 'AuthenticationRequired', 'no'), 1, NOW_MS), undefined);
  assert.equal(retryDelayMs(new Error('bug'), 1, NOW_MS), undefined);
});

test('rateLimitWaitMs falls back, clamps and pads', () => {
  const nowSeconds = NOW_MS / 1_000;
  assert.equal(rateLimitWaitMs(undefined, NOW_MS), 60_000);
  assert.equal(rateLimitWaitMs({ 'ratelimit-reset': 'soon' }, NOW_MS), 60_000);
  assert.equal(rateLimitWaitMs({ 'ratelimit-reset': String(nowSeconds - 30) }, NOW_MS), 60_000);
  assert.equal(rateLimitWaitMs({ 'ratelimit-reset': String(nowSeconds + 60) }, NOW_MS), 61_000);
  assert.equal(rateLimitWaitMs({ 'ratelimit-reset': String(nowSeconds * 1_000) }, NOW_MS), 24 * HOUR_MS);
});

test('formatDuration is readable at every scale', () => {
  assert.equal(formatDuration(34_308_000), '9h 31m');
  assert.equal(formatDuration(125_000), '2m 5s');
  assert.equal(formatDuration(900), '1s');
});
