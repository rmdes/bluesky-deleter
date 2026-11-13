# bluesky-deleter

Bulk-delete the posts on your Bluesky account(s) that link to particular domains. Useful when you shared many links to a site and now want them gone without clicking through thousands of posts.

Background: [How to bulk delete Bluesky posts](https://blog.rmendes.net/2024/12/15/how-to-bulk.html) (describes the original single-file version).

> **Deletion is permanent.** Bluesky has no trash or undo. Always do a [dry run](#3-dry-run-first) before a real one.

## Contents

- [Quick start](#quick-start)
- [Requirements](#requirements)
- [Step-by-step](#step-by-step)
- [Configuration reference](#configuration-reference)
- [Command reference](#command-reference)
- [What gets deleted](#what-gets-deleted)
- [Rate limits and how long it takes](#rate-limits-and-how-long-it-takes)
- [Stopping, resuming and starting over](#stopping-resuming-and-starting-over)
- [Running a long sweep unattended](#running-a-long-sweep-unattended)
- [Reading the output](#reading-the-output)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Development](#development)

## Quick start

```bash
git clone https://github.com/rmdes/bluesky-deleter.git
cd bluesky-deleter
npm install
cp .env.example .env        # then edit .env: handle, app password, domains
npm run sweep -- --dry-run  # counts matching posts, deletes nothing
npm run sweep               # deletes them
```

## Requirements

- **Node.js 22.18 or newer.** The tool runs its TypeScript sources directly, with no build step. Check with `node --version`.
- **A Bluesky app password** for each account you want to clean (see below).

## Step-by-step

### 1. Install

```bash
npm install
```

### 2. Configure your accounts

Create an app password for each account at **Settings → Privacy and security → App passwords** ([direct link](https://bsky.app/settings/app-passwords)). It looks like `xxxx-xxxx-xxxx-xxxx`. Use an app password, never your main password: it can be revoked on its own and cannot change account settings.

Copy the template and fill it in:

```bash
cp .env.example .env
```

One account:

```ini
BSKY_1_HANDLE=your-handle.bsky.social
BSKY_1_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
BSKY_1_DOMAINS=example.com
```

Several accounts, each with its own domains:

```ini
BSKY_1_HANDLE=your-handle.bsky.social
BSKY_1_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
BSKY_1_DOMAINS=example.com

BSKY_2_HANDLE=another-handle.example.com
BSKY_2_APP_PASSWORD=yyyy-yyyy-yyyy-yyyy
BSKY_2_DOMAINS=example.org,example.net
```

The **domain to delete by** is `BSKY_<n>_DOMAINS`. See the [configuration reference](#configuration-reference) for the exact rules.

### 3. Dry run first

```bash
npm run sweep -- --dry-run
```

This logs in, reads every post and reports how many would be deleted. It deletes nothing and saves no progress. A repo of about 34,000 posts takes roughly a minute.

```
2026-11-13T10:55:48.161Z [your-handle.bsky.social] Logged in as did:plc:abc123; sweeping example.com (dry run)
2026-11-13T10:55:48.541Z [your-handle.bsky.social] scanned 100 · would delete 37
...
2026-11-13T10:56:39.836Z [your-handle.bsky.social] Done: scanned 33973 posts, would delete 12804
```

If the "would delete" number is not what you expect, fix `BSKY_<n>_DOMAINS` and repeat before going further.

### 4. Delete

```bash
npm run sweep
```

All configured accounts are swept at the same time. To limit a run to one account:

```bash
npm run sweep -- --account your-handle.bsky.social
```

For more than about 5,000 matching posts the run will pause on rate limits; see [how long it takes](#rate-limits-and-how-long-it-takes).

## Configuration reference

All configuration lives in `.env`, in numbered blocks: `BSKY_1_*` for the first account, `BSKY_2_*` for the second, and so on.

| Variable | Required | Meaning |
|----------|----------|---------|
| `BSKY_<n>_HANDLE` | yes | Account handle, with or without a leading `@` |
| `BSKY_<n>_APP_PASSWORD` | yes | App password for that account |
| `BSKY_<n>_DOMAINS` | yes | Domains whose links mark a post for deletion |
| `BSKY_<n>_SERVICE` | no | PDS or entryway URL. Defaults to `https://bsky.social`; set it if the account lives on a self-hosted PDS. Must be `https` |

Rules:

- **Numbering starts at 1 and must be contiguous.** Reading stops at the first missing `BSKY_<n>_HANDLE`, so with blocks 1 and 3 but no 2, only account 1 is used.
- **Domains are bare hostnames**, comma-separated: `example.com,example.org`. A URL such as `https://example.com/page` is rejected at startup.
- **Subdomains are included.** `example.com` also covers `www.example.com` and `videos.example.com`. To target only one subdomain, list that subdomain instead.
- Variables already set in your shell environment work too; `.env` is just the convenient place for them.

## Command reference

```
npm run sweep -- [options]
```

| Option | Effect |
|--------|--------|
| `--dry-run` | Scan and count matching posts without deleting anything. Ignores and never writes the checkpoint |
| `--account <handle>` | Only sweep this account. Repeat the option for several accounts |
| `--help` | Show usage |

The `--` after `npm run sweep` is required so that npm passes the options through. Without npm, the equivalent is `node --env-file-if-exists=.env src/main.ts [options]`.

Exit code is `0` when every account finished and `1` if any account failed or the configuration is invalid.

## What gets deleted

The tool looks only at your own posts (`app.bsky.feed.post`, which includes replies and quote posts). It never touches likes, reposts, follows or other people's content.

A post is deleted when at least one of its links points at a configured domain or a subdomain of it. Links are read from:

- rich-text links in the post text (`app.bsky.richtext.facet#link`)
- the link card (`app.bsky.embed.external`), including a link card attached to a quote post
- legacy `entities` of type `link` on very old posts

Matching is done on the link's hostname:

| Link in the post | `BSKY_1_DOMAINS=example.com` |
|------------------|------------------------------|
| `https://example.com/article` | deleted |
| `https://videos.example.com/clip#12` | deleted (subdomain) |
| `https://notexample.com/` | kept (different domain) |
| `https://other.org/?ref=example.com` | kept (domain only appears in the query) |
| `example.com` typed as plain text, not a clickable link | kept |

The last row is the main limitation: a domain mentioned in plain text, with no link facet or link card, is not matched.

## Rate limits and how long it takes

Bluesky gives each account a write budget of **5,000 points per hour and 35,000 points per day**. A delete costs 1 point. This is a server-side limit and no client can go faster.

| Posts to delete | Minimum time |
|-----------------|--------------|
| up to 5,000 | a few minutes |
| 20,000 | about 3 hours |
| 34,000 | about 6 hours, using nearly the whole daily budget |
| 70,000 | 2 days |

These assume a fresh budget. Anything else that writes to the account (posting, liking, another tool) draws on the same budget.

When the budget runs out, the server refuses further deletes and says when the window resets. The tool logs that time and sleeps until then:

```
[your-handle.bsky.social] Rate limited (policy 5000;w=3600). Resuming at 13/11/2026, 14:00:01, in 42m 10s. Progress is saved; safe to stop and restart.
```

A wait of many hours means the daily budget is spent. That is normal for a large cleanup; the sweep is waiting, not stuck. Each account has its own budget, so accounts never slow each other down.

## Stopping, resuming and starting over

After each page of 100 posts the tool saves its position to `.sweep-state.json` in the directory you run it from.

- **Stop** at any time with `Ctrl-C`, including during a rate-limit wait.
- **Resume** by running `npm run sweep` again. It continues from the saved position:

  ```
  [your-handle.bsky.social] Resuming from checkpoint: scanned 12400 · deleted 9800. Delete the checkpoint file for a full rescan.
  ```

- **Start over** by deleting the file: `rm .sweep-state.json`. Posts already deleted stay deleted; the tool just rescans from the oldest post.

Details worth knowing:

- Progress is stored per account and per set of domains. Changing `BSKY_<n>_DOMAINS` starts a fresh sweep for the new set.
- When a sweep completes, its entry is removed, so the next run scans the whole account again.
- Posts are processed oldest first, so anything you post during a sweep is still reached.
- Run only one instance at a time from a given directory.

## Running a long sweep unattended

A large cleanup spans hours or days. Either leave it running or re-run it periodically; both work because progress is saved.

Leave it running in the background, logging to a file:

```bash
nohup npm run sweep > sweep.log 2>&1 &
tail -f sweep.log
```

Or run it inside `tmux` or `screen` and detach. If the machine restarts or the process dies, start it again and it resumes.

## Reading the output

Every line has a UTC timestamp and the account it belongs to.

| Line | Meaning |
|------|---------|
| `Logged in as did:plc:…; sweeping example.com` | Login succeeded; lists the domains in effect |
| `scanned 300 · deleted 120 · write budget left 4880` | Running totals after a page. "Write budget left" is the server's remaining count for the current window |
| `scanned 300 · would delete 120` | Same, in a dry run |
| `Resuming from checkpoint: …` | Continuing an earlier run |
| `Rate limited (policy …). Resuming at …` | Budget spent; sleeping until the reset |
| `Request failed (…); retry 1/4 in 2s` | A network or server error; retried up to four times with increasing delays |
| `Done: scanned N posts, deleted M` | That account is finished |
| `Failed: …` | That account stopped on an error; other accounts continue. Re-run to resume |

## Troubleshooting

| Message or symptom | Cause and fix |
|--------------------|---------------|
| `.env not found. Continuing without it.` followed by `No accounts configured` | There is no `.env` in the current directory. Run from the project root after `cp .env.example .env` |
| `BSKY_1_APP_PASSWORD is required for …` | The handle is set but its password line is missing or empty |
| `BSKY_1_DOMAINS must hold bare domains like "example.com"` | A URL or path was given. Use just the hostname |
| `--account not found in .env: …` | The handle passed to `--account` does not match any `BSKY_<n>_HANDLE` |
| `Failed: Invalid identifier or password` | Wrong handle or app password, or the app password was revoked. Create a new one |
| Only the first account runs | A gap in the numbering; see [configuration reference](#configuration-reference) |
| `Unknown file extension ".ts"` or a syntax error on startup | Node.js is older than 22.18. Upgrade it |
| It has been "Rate limited" for hours | The daily budget is spent. Leave it or restart it later; see [rate limits](#rate-limits-and-how-long-it-takes) |
| `Checkpoint file … is unreadable` | `.sweep-state.json` is corrupt. Delete it; the sweep rescans from the start |
| An account stops with `Failed:` right after a network hiccup | A delete went through but its reply was lost. Run again; it resumes from the last saved page |
| Dry run finds 0 posts | Check the domain spelling, and that the posts contain real links rather than plain text |

## Security

- `.env` holds your app passwords. It is listed in `.gitignore`; never commit it or paste it anywhere.
- Passwords are only sent to the configured service for login. They are not logged and not written to `.sweep-state.json`, which holds only the account DID, the domains, a position and two counters.
- When you are done, revoke the app password in Bluesky's settings.
- `npm audit` currently reports an advisory in `zod`, a dependency of `@atproto/api`. It concerns memory use when validating hostile oversized input, which this tool does not process, and the fix npm offers is a downgrade of `@atproto/api`. Do not run `npm audit fix --force`.

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

How a sweep works: for each account, the tool pages through the post collection oldest-first, 100 records at a time. Each page's matching posts are deleted in a single `applyWrites` call before the next page is fetched, then the cursor is saved. Records are paged by key, so deleting behind the cursor never skips a post, and memory use stays constant however large the account is.
