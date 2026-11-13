# bluesky-deleter

Bulk-delete the posts on your Bluesky account(s) that link to particular domains. Useful when you shared many links to a site and now want them gone without clicking through thousands of posts.

Background: [How to bulk delete Bluesky posts](https://blog.rmendes.net/2024/12/15/how-to-bulk.html) (describes the original single-file version).

## How it works

For each account, the tool walks the post collection oldest-first, 100 records at a time. Each page's matching posts are deleted in one `applyWrites` call before the next page is fetched, and the position is saved to `.sweep-state.json`. Memory use is constant and a stopped run resumes where it left off.

A post matches when one of its links points at a configured domain or a subdomain of it. Links are read from:

- rich-text link facets (`app.bsky.richtext.facet#link`)
- link-card embeds (`app.bsky.embed.external`), including inside a quote-with-media embed
- legacy `entities` of type `link`

Matching is on the URL's hostname, so `example.com` matches `videos.example.com` but not `notexample.com` or a URL that only mentions the domain in its path or query. A domain written in plain text without a link is not matched.

## Rate limits: large cleanups take hours or days

Bluesky's PDS gives each account a write budget of **5,000 points per hour and 35,000 points per day**, and a delete costs 1 point. So deleting 34,000 posts takes at least seven hours, and anything above 35,000 spills into the next day. This is a server limit; no client can go faster.

When the budget runs out the server answers `429` with a `ratelimit-reset` time. The tool logs when it will resume and sleeps until then:

```
[you.bsky.social] Rate limited (policy 35000;w=86400). Resuming at 14/11/2026, 08:41:07, in 9h 31m. Progress is saved; safe to stop and restart.
```

You can leave it running, or stop it and start it again later. Either way it continues from the checkpoint. Accounts are swept concurrently, since each has its own budget.

## Setup

Requires Node.js 22.18 or newer (it runs the TypeScript sources directly).

```bash
npm install
cp .env.example .env
```

Then fill in `.env`, one numbered block per account:

```ini
BSKY_1_HANDLE=your-handle.bsky.social
BSKY_1_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
BSKY_1_DOMAINS=example.com

BSKY_2_HANDLE=another-handle.example.com
BSKY_2_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
BSKY_2_DOMAINS=example.org,example.net
```

| Variable | Required | Meaning |
|----------|----------|---------|
| `BSKY_<n>_HANDLE` | yes | Account handle |
| `BSKY_<n>_APP_PASSWORD` | yes | An [app password](https://bsky.app/settings/app-passwords), not your main password |
| `BSKY_<n>_DOMAINS` | yes | Comma-separated bare domains to sweep |
| `BSKY_<n>_SERVICE` | no | PDS or entryway URL, defaults to `https://bsky.social` |

Numbering starts at 1 and must be contiguous. `.env` is git-ignored; never commit it.

## Usage

Deletion is permanent, so start with a dry run. It scans everything and reports how many posts would be deleted, without deleting any:

```bash
npm run sweep -- --dry-run
```

Then run it for real:

```bash
npm run sweep
```

| Option | Effect |
|--------|--------|
| `--dry-run` | Count matching posts without deleting |
| `--account <handle>` | Only sweep this account; repeatable |
| `--help` | Show usage |

To restart a sweep from the beginning, delete `.sweep-state.json`.

## Development

```bash
npm test           # node:test, no network access needed
npm run typecheck
```

| File | Responsibility |
|------|----------------|
| `src/main.ts` | CLI entry: arguments, login, one sweep per account |
| `src/config.ts` | Reads and validates accounts from the environment |
| `src/match.ts` | Decides whether a post links to a target domain |
| `src/sweep.ts` | The fetch, delete and checkpoint loop, with retry and rate-limit handling |
| `src/checkpoint.ts` | Progress persistence |
