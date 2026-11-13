import { parseArgs } from 'node:util';
import { AtpAgent } from '@atproto/api';
import { fileCheckpoints, type Checkpoints } from './checkpoint.ts';
import { loadAccounts, type Account } from './config.ts';
import { sweep } from './sweep.ts';

const CHECKPOINT_FILE = '.sweep-state.json';

const USAGE = `Usage: npm run sweep -- [options]

Deletes every post linking to the configured domains, for each account in .env.
Interrupted runs resume from ${CHECKPOINT_FILE}.

Options:
  --dry-run            Scan and count matching posts without deleting anything
  --account <handle>   Only sweep this account (repeatable)
  --help               Show this message
`;

const timestamped = (message: string): string => `${new Date().toISOString()} ${message}\n`;
const info = (message: string): void => void process.stdout.write(timestamped(message));
const fail = (message: string): void => void process.stderr.write(timestamped(message));

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function selectAccounts(accounts: Account[], wanted: string[]): Account[] {
  if (wanted.length === 0) return accounts;
  const handles = wanted.map((handle) => handle.replace(/^@/, ''));
  const unknown = handles.filter((handle) => !accounts.some((account) => account.handle === handle));
  if (unknown.length > 0) throw new Error(`--account not found in .env: ${unknown.join(', ')}`);
  return accounts.filter((account) => handles.includes(account.handle));
}

async function sweepAccount(account: Account, dryRun: boolean, checkpoints: Checkpoints): Promise<void> {
  const log = (message: string): void => info(`[${account.handle}] ${message}`);
  const agent = new AtpAgent({ service: account.service });
  await agent.login({ identifier: account.handle, password: account.password });
  log(`Logged in as ${agent.assertDid}; sweeping ${account.domains.join(', ')}${dryRun ? ' (dry run)' : ''}`);

  const result = await sweep({
    repo: agent.com.atproto.repo,
    did: agent.assertDid,
    domains: account.domains,
    dryRun,
    checkpoints,
    log,
  });
  log(`Done: scanned ${result.scanned} posts, ${dryRun ? 'would delete' : 'deleted'} ${result.matched}`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'dry-run': { type: 'boolean', default: false },
      account: { type: 'string', multiple: true, default: [] },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const accounts = selectAccounts(loadAccounts(process.env), values.account);
  const checkpoints = fileCheckpoints(CHECKPOINT_FILE);

  // Write budgets are per account, so one account waiting on its limit must not block the others.
  const outcomes = await Promise.allSettled(
    accounts.map((account) => sweepAccount(account, values['dry-run'], checkpoints)),
  );
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'fulfilled') return;
    fail(`[${accounts[index]?.handle}] Failed: ${errorMessage(outcome.reason)}`);
    process.exitCode = 1;
  });
}

main().catch((error: unknown) => {
  fail(errorMessage(error));
  process.exitCode = 1;
});
