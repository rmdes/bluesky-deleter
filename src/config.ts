export interface Account {
  handle: string;
  password: string;
  domains: string[];
  service: string;
}

type Env = Record<string, string | undefined>;

const DEFAULT_SERVICE = 'https://bsky.social';
const DOMAIN = /^([a-z\d]([a-z\d-]*[a-z\d])?\.)+[a-z]{2,}$/;

function parseDomains(raw: string, key: string): string[] {
  const domains = raw
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean);
  if (domains.length === 0) throw new Error(`${key} is required (comma-separated domains to sweep)`);

  const invalid = domains.filter((domain) => !DOMAIN.test(domain));
  if (invalid.length > 0) {
    throw new Error(`${key} must hold bare domains like "example.com", got: ${invalid.join(', ')}`);
  }
  return domains;
}

function parseService(raw: string | undefined, key: string): string {
  const service = raw?.trim();
  if (!service) return DEFAULT_SERVICE;
  if (!URL.canParse(service) || new URL(service).protocol !== 'https:') {
    throw new Error(`${key} must be an https URL, got: ${service}`);
  }
  return service;
}

function parseAccount(env: Env, index: number): Account | undefined {
  const prefix = `BSKY_${index}`;
  const handle = env[`${prefix}_HANDLE`]?.trim().replace(/^@/, '');
  if (!handle) return undefined;

  const password = env[`${prefix}_APP_PASSWORD`]?.trim();
  if (!password) throw new Error(`${prefix}_APP_PASSWORD is required for ${handle}`);

  return {
    handle,
    password,
    domains: parseDomains(env[`${prefix}_DOMAINS`] ?? '', `${prefix}_DOMAINS`),
    service: parseService(env[`${prefix}_SERVICE`], `${prefix}_SERVICE`),
  };
}

/** Reads BSKY_1_*, BSKY_2_*, ... until the first index without a handle. */
export function loadAccounts(env: Env): Account[] {
  const accounts: Account[] = [];
  for (let index = 1; ; index++) {
    const account = parseAccount(env, index);
    if (!account) break;
    accounts.push(account);
  }
  if (accounts.length === 0) {
    throw new Error('No accounts configured: copy .env.example to .env and fill in BSKY_1_*');
  }
  return accounts;
}
