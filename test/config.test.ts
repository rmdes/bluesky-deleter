import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAccounts } from '../src/config.ts';

const FIRST = {
  BSKY_1_HANDLE: '@one.example.com',
  BSKY_1_APP_PASSWORD: 'aaaa-bbbb-cccc-dddd',
  BSKY_1_DOMAINS: ' Example.com , example.org ',
};

test('reads every numbered account with defaults applied', () => {
  const accounts = loadAccounts({
    ...FIRST,
    BSKY_2_HANDLE: 'two.bsky.social',
    BSKY_2_APP_PASSWORD: 'eeee-ffff-gggg-hhhh',
    BSKY_2_DOMAINS: 'example.net',
    BSKY_2_SERVICE: 'https://pds.example.net',
  });

  assert.deepEqual(accounts, [
    {
      handle: 'one.example.com',
      password: 'aaaa-bbbb-cccc-dddd',
      domains: ['example.com', 'example.org'],
      service: 'https://bsky.social',
    },
    {
      handle: 'two.bsky.social',
      password: 'eeee-ffff-gggg-hhhh',
      domains: ['example.net'],
      service: 'https://pds.example.net',
    },
  ]);
});

test('stops at the first gap in the numbering', () => {
  const accounts = loadAccounts({ ...FIRST, BSKY_3_HANDLE: 'three.bsky.social' });
  assert.equal(accounts.length, 1);
});

test('throws when no account is configured', () => {
  assert.throws(() => loadAccounts({}), /No accounts configured/);
});

test('throws when the app password is missing', () => {
  assert.throws(() => loadAccounts({ ...FIRST, BSKY_1_APP_PASSWORD: ' ' }), /BSKY_1_APP_PASSWORD is required/);
});

test('throws when domains are missing', () => {
  assert.throws(() => loadAccounts({ ...FIRST, BSKY_1_DOMAINS: ' , ' }), /BSKY_1_DOMAINS is required/);
});

test('throws when a domain is given as a URL', () => {
  assert.throws(
    () => loadAccounts({ ...FIRST, BSKY_1_DOMAINS: 'https://example.com/path' }),
    /bare domains.*https:\/\/example\.com\/path/,
  );
});

test('throws when the service is not https', () => {
  assert.throws(() => loadAccounts({ ...FIRST, BSKY_1_SERVICE: 'http://pds.example.net' }), /must be an https URL/);
});
