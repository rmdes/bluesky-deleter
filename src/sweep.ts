import { AtUri, XRPCError, type AtpAgent } from '@atproto/api';
import type { Checkpoints, Progress } from './checkpoint.ts';
import { postMatches } from './match.ts';

const POST_COLLECTION = 'app.bsky.feed.post';
const DELETE_OP = 'com.atproto.repo.applyWrites#delete';
/** listRecords maximum; also keeps one page of deletes under applyWrites' 200-write cap. */
const PAGE_SIZE = 100;

const HTTP_RATE_LIMITED = 429;
const HTTP_SERVER_ERROR = 500;
/** What @atproto/xrpc reports when the request never got an HTTP response. */
const STATUS_NETWORK_FAILURE = 1;

const MAX_TRANSIENT_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 1_000;
const RESET_PADDING_MS = 1_000;
const DEFAULT_RATE_LIMIT_WAIT_MS = 60_000;
/** The longest real window is the daily write budget, so anything above is a bogus header. */
const MAX_RATE_LIMIT_WAIT_MS = 24 * 60 * 60 * 1_000;

export type Repo = Pick<AtpAgent['com']['atproto']['repo'], 'listRecords' | 'applyWrites'>;

export interface SweepOptions {
  repo: Repo;
  did: string;
  domains: readonly string[];
  dryRun: boolean;
  checkpoints: Checkpoints;
  log: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface RetryContext {
  log: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function formatDuration(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${totalSeconds % 60}s`;
  return `${totalSeconds}s`;
}

/** How long to wait for the server's rate-limit window, from its `ratelimit-reset` (epoch seconds). */
export function rateLimitWaitMs(headers: Record<string, string | undefined> | undefined, nowMs: number): number {
  const resetSeconds = Number(headers?.['ratelimit-reset']);
  if (!Number.isFinite(resetSeconds) || resetSeconds <= 0) return DEFAULT_RATE_LIMIT_WAIT_MS;
  const untilReset = resetSeconds * 1_000 - nowMs;
  // Still limited although the reset has passed (clock skew, stale header): back off, don't hammer.
  if (untilReset <= 0) return DEFAULT_RATE_LIMIT_WAIT_MS;
  return Math.min(untilReset + RESET_PADDING_MS, MAX_RATE_LIMIT_WAIT_MS);
}

const isRateLimited = (error: unknown): boolean =>
  error instanceof XRPCError && (error.status as number) === HTTP_RATE_LIMITED;

/**
 * Delay before retrying a failed call, or undefined when the error is not worth retrying.
 * `transientFailures` counts network/5xx failures only; rate limits are waited out indefinitely.
 */
export function retryDelayMs(error: unknown, transientFailures: number, nowMs: number): number | undefined {
  if (!(error instanceof XRPCError)) return undefined;
  if (isRateLimited(error)) return rateLimitWaitMs(error.headers, nowMs);

  const status: number = error.status;
  const isTransient = status === STATUS_NETWORK_FAILURE || status >= HTTP_SERVER_ERROR;
  if (!isTransient || transientFailures >= MAX_TRANSIENT_ATTEMPTS) return undefined;
  return BACKOFF_BASE_MS * 2 ** transientFailures;
}

function describeRetry(error: XRPCError, transientFailures: number, waitMs: number, nowMs: number): string {
  if (!isRateLimited(error)) {
    return `Request failed (${error.message}); retry ${transientFailures}/${MAX_TRANSIENT_ATTEMPTS - 1} in ${formatDuration(waitMs)}`;
  }
  const policy = error.headers?.['ratelimit-policy'] ?? 'unknown';
  const resumeAt = new Date(nowMs + waitMs).toLocaleString();
  return `Rate limited (policy ${policy}). Resuming at ${resumeAt}, in ${formatDuration(waitMs)}. Progress is saved; safe to stop and restart.`;
}

// ponytail: purely reactive (wait when the server says 429). Track ratelimit-remaining
// and pause ahead of time only if the wasted 429 round-trips ever matter.
async function withRetry<T>(call: () => Promise<T>, { log, sleep, now }: RetryContext): Promise<T> {
  let transientFailures = 0;
  for (;;) {
    try {
      return await call();
    } catch (error) {
      if (!isRateLimited(error)) transientFailures++;
      const waitMs = retryDelayMs(error, transientFailures, now());
      if (waitMs === undefined || !(error instanceof XRPCError)) throw error;
      log(describeRetry(error, transientFailures, waitMs, now()));
      await sleep(waitMs);
    }
  }
}

function describeProgress(progress: Progress, dryRun: boolean, budgetLeft: string | undefined): string {
  const verb = dryRun ? 'would delete' : 'deleted';
  const budget = budgetLeft === undefined ? '' : ` · write budget left ${budgetLeft}`;
  return `scanned ${progress.scanned} · ${verb} ${progress.matched}${budget}`;
}

/**
 * Walks the account's posts oldest-first, deleting each page's matches before moving on.
 * Records are paged by rkey, so deleting behind the cursor never skips anything.
 */
export async function sweep(options: SweepOptions): Promise<Progress> {
  const { repo, did, domains, dryRun, checkpoints, log } = options;
  const retry: RetryContext = { log, sleep: options.sleep ?? defaultSleep, now: options.now ?? Date.now };
  const key = `${did}|${[...domains].sort().join(',')}`;

  // A dry run always scans the whole repo and never touches the checkpoint.
  const saved = dryRun ? undefined : checkpoints.load(key);
  if (saved) {
    log(`Resuming from checkpoint: ${describeProgress(saved, dryRun, undefined)}. Delete the checkpoint file for a full rescan.`);
  }
  let progress: Progress = saved ?? { scanned: 0, matched: 0 };

  for (;;) {
    const { cursor } = progress;
    const page = await withRetry(
      () => repo.listRecords({ repo: did, collection: POST_COLLECTION, limit: PAGE_SIZE, cursor, reverse: true }),
      retry,
    );
    const { records, cursor: nextCursor } = page.data;
    const writes = records
      .filter((record) => postMatches(record.value, domains))
      .map((record) => ({ $type: DELETE_OP, collection: POST_COLLECTION, rkey: new AtUri(record.uri).rkey }) as const);

    const deletion =
      writes.length > 0 && !dryRun ? await withRetry(() => repo.applyWrites({ repo: did, writes }), retry) : undefined;

    progress = {
      cursor: nextCursor,
      scanned: progress.scanned + records.length,
      matched: progress.matched + writes.length,
    };
    log(describeProgress(progress, dryRun, deletion?.headers['ratelimit-remaining']));

    if (!nextCursor || records.length === 0) break;
    if (!dryRun) checkpoints.save(key, progress);
  }

  if (!dryRun) checkpoints.clear(key);
  return progress;
}
