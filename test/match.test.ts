import assert from 'node:assert/strict';
import { test } from 'node:test';
import { postMatches, urlMatchesDomain } from '../src/match.ts';

const DOMAINS = ['osintukraine.com'];
const TARGET_URL = 'https://videosua.osintukraine.com/2025-10_7.html#156437';

const linkFacet = (uri: unknown) => ({ features: [{ $type: 'app.bsky.richtext.facet#link', uri }] });
const externalEmbed = (uri: string) => ({ $type: 'app.bsky.embed.external', external: { uri } });

test('matches the domain itself and its subdomains', () => {
  assert.equal(urlMatchesDomain('https://osintukraine.com/a', DOMAINS), true);
  assert.equal(urlMatchesDomain(TARGET_URL, DOMAINS), true);
  assert.equal(urlMatchesDomain('HTTPS://OSINTUkraine.com', DOMAINS), true);
});

test('matches scheme-less links, with or without a port', () => {
  assert.equal(urlMatchesDomain('osintukraine.com/page', DOMAINS), true);
  assert.equal(urlMatchesDomain('osintukraine.com:8443/page', DOMAINS), true);
});

test('does not match lookalike domains or mentions outside the host', () => {
  assert.equal(urlMatchesDomain('https://notosintukraine.com', DOMAINS), false);
  assert.equal(urlMatchesDomain('https://osintukraine.com.evil.net', DOMAINS), false);
  assert.equal(urlMatchesDomain('https://example.org/?ref=osintukraine.com', DOMAINS), false);
  assert.equal(urlMatchesDomain('mailto:someone@osintukraine.com', DOMAINS), false);
});

test('only matches web links, not other schemes pointing at the domain', () => {
  assert.equal(urlMatchesDomain('at://osintukraine.com/app.bsky.feed.post/abc', DOMAINS), false);
  assert.equal(urlMatchesDomain('ftp://osintukraine.com/file', DOMAINS), false);
  assert.equal(urlMatchesDomain('http://osintukraine.com/page', DOMAINS), true);
});

test('matches a fully-qualified hostname with a trailing dot', () => {
  assert.equal(urlMatchesDomain('https://osintukraine.com./page', DOMAINS), true);
});

test('does not match values that are not URLs', () => {
  assert.equal(urlMatchesDomain(undefined, DOMAINS), false);
  assert.equal(urlMatchesDomain(42, DOMAINS), false);
  assert.equal(urlMatchesDomain('', DOMAINS), false);
});

test('finds the domain in a rich-text link facet', () => {
  assert.equal(postMatches({ text: 'x', facets: [linkFacet(TARGET_URL)] }, DOMAINS), true);
});

test('ignores facets that are not links', () => {
  const mention = { features: [{ $type: 'app.bsky.richtext.facet#mention', did: 'did:plc:osintukraine.com' }] };
  assert.equal(postMatches({ text: 'x', facets: [mention] }, DOMAINS), false);
});

test('finds the domain in a link-card embed', () => {
  assert.equal(postMatches({ text: 'x', embed: externalEmbed(TARGET_URL) }, DOMAINS), true);
});

test('finds the domain in a link card nested inside a quote-with-media embed', () => {
  const embed = { $type: 'app.bsky.embed.recordWithMedia', media: externalEmbed(TARGET_URL) };
  assert.equal(postMatches({ text: 'x', embed }, DOMAINS), true);
});

test('finds the domain in legacy entities', () => {
  assert.equal(postMatches({ text: 'x', entities: [{ type: 'link', value: TARGET_URL }] }, DOMAINS), true);
});

test('does not match posts linking elsewhere or carrying no links', () => {
  assert.equal(postMatches({ text: 'osintukraine.com in plain text only' }, DOMAINS), false);
  assert.equal(postMatches({ text: 'x', facets: [linkFacet('https://example.org')] }, DOMAINS), false);
});

test('survives malformed records', () => {
  assert.equal(postMatches(null, DOMAINS), false);
  assert.equal(postMatches({ facets: 'nope', embed: 7, entities: [null, 'x'] }, DOMAINS), false);
  assert.equal(postMatches({ facets: [null, { features: [null, linkFacet(3)] }] }, DOMAINS), false);
});
