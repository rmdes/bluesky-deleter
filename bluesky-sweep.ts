import { BskyAgent } from '@atproto/api';
import { pRateLimit } from 'p-ratelimit';

const VERBOSE = true;
const TARGET_DOMAIN = 'futura-sciences.com';

// Known limits
const MAX_DELETES_PER_HOUR = 5000;

// Configure the batch size and delays
const DELETES_PER_BATCH = 200;
const DELAY_BETWEEN_BATCHES_MS = 5000; // 5 seconds between batches
const SAFE_MARGIN = 100; // Start pausing before we hit exactly 5000

(async () => {
  const agent = new BskyAgent({ service: 'https://bsky.social' });
  await agent.login({
    identifier: 'handle',
    password: 'app-password',
  });

  console.log(`Logged in as ${agent.session!.handle} (${agent.session!.did})`);

  const limit = pRateLimit({ concurrency: 3, interval: 1000, rate: 5 });

  const getRecordId = (uri: string) => {
    const idx = uri.lastIndexOf('/');
    return uri.slice(idx + 1);
  };

  const chunked = <T>(arr: T[], size: number): T[][] => {
    const chunks: T[][] = [];
    for (let idx = 0; idx < arr.length; idx += size) {
      chunks.push(arr.slice(idx, idx + size));
    }
    return chunks;
  };

  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

  let deletes: any[] = [];
  let cursor: string | undefined;
  let batchCount = 0;

  // Fetch posts and determine which to delete
  do {
    console.log(`Fetching records (cursor: ${cursor || 'none'})...`);
    const response = await limit(() =>
      agent.api.com.atproto.repo.listRecords({
        repo: agent.session!.did,
        collection: 'app.bsky.feed.post',
        limit: 100,
        cursor,
        reverse: true,
      })
    );

    cursor = response.data.cursor;
    batchCount++;
    console.log(`Processing batch #${batchCount}, ${response.data.records.length} records fetched`);

    for (const record of response.data.records) {
      if (VERBOSE) console.log(`\nChecking record URI: ${record.uri}`);
      const val = record.value as any;

      let found = false;

      // Check facets for links
      const facets = val?.facets || [];
      for (const facet of facets) {
        const features = facet.features || [];
        for (const feature of features) {
          if (feature.$type === 'app.bsky.richtext.facet#link' && feature.uri.includes(TARGET_DOMAIN)) {
            if (VERBOSE) console.log(`Found target domain in facet link: ${feature.uri}`);
            found = true;
            break;
          }
        }
        if (found) break;
      }

      // Check embed if not found yet
      if (!found && val?.embed) {
        const embed = val.embed;
        if (embed.$type === 'app.bsky.embed.external' && embed.external?.uri?.includes(TARGET_DOMAIN)) {
          if (VERBOSE) console.log(`Found target domain in embed: ${embed.external.uri}`);
          found = true;
        }
      }

      // Check entities (legacy) if not found yet
      if (!found && val?.entities && Array.isArray(val.entities)) {
        for (const entity of val.entities) {
          if (entity.type === 'link' && entity.value.includes(TARGET_DOMAIN)) {
            if (VERBOSE) console.log(`Found target domain in entities link: ${entity.value}`);
            found = true;
            break;
          }
        }
      }

      if (found) {
        deletes.push({
          $type: 'com.atproto.repo.applyWrites#delete',
          collection: 'app.bsky.feed.post',
          rkey: getRecordId(record.uri),
        });
      }
    }
  } while (cursor);

  console.log(`\nFound ${deletes.length} posts containing '${TARGET_DOMAIN}'`);

  if (deletes.length === 0) {
    console.log('No posts to delete.');
    return;
  }

  const chunkedDeletes = chunked(deletes, DELETES_PER_BATCH);
  console.log(`Deletion can be done in ${chunkedDeletes.length} batched operations`);

  // Keep track of how many deletes we have performed in the current hour window
  let hourWindowStart = Date.now();
  let deletesThisHour = 0;

  for (let idx = 0; idx < chunkedDeletes.length; idx++) {
    const chunk = chunkedDeletes[idx];

    // Check if adding this batch exceeds the hourly limit threshold
    if (deletesThisHour + chunk.length > (MAX_DELETES_PER_HOUR - SAFE_MARGIN)) {
      // We need to wait until an hour has passed since hourWindowStart
      const now = Date.now();
      const elapsed = now - hourWindowStart;
      const oneHourMs = 3600000;
      if (elapsed < oneHourMs) {
        const waitTime = oneHourMs - elapsed;
        console.log(`Approaching hourly limit. Waiting ${Math.ceil(waitTime / 60000)} minutes to reset.`);
        await sleep(waitTime);
      }
      // Reset the hour window
      hourWindowStart = Date.now();
      deletesThisHour = 0;
    }

    console.log(`Deleting batch #${idx + 1} with ${chunk.length} posts...`);

    // Implement a retry loop in case of rate limit errors
    let success = false;
    while (!success) {
      try {
        await limit(() =>
          agent.api.com.atproto.repo.applyWrites({
            repo: agent.session!.did,
            writes: chunk,
          })
        );
        console.log(`Batch operation #${idx + 1} completed`);
        success = true;
      } catch (error: any) {
        if (error.status === 429) {
          console.warn('Rate limit exceeded, checking headers to wait until reset...');
          const resetTimeStr = error.headers?.['ratelimit-reset'];
          let waitSeconds = 60; // default to 60s if no reset time provided

          if (resetTimeStr) {
            const resetTime = parseInt(resetTimeStr, 10);
            const now = Math.floor(Date.now() / 1000);
            const diff = resetTime - now;
            if (diff > 0) {
              waitSeconds = diff;
            }
          }

          console.log(`Waiting ${waitSeconds} seconds before retrying...`);
          await sleep(waitSeconds * 1000);
          console.log('Retrying this batch...');
        } else {
          console.error(`Error performing batch #${idx + 1}:`, error);
          // For non-rate-limit errors, we may just break or handle differently
          break;
        }
      }
    }

    // If successful, increment counters
    if (success) {
      deletesThisHour += chunk.length;
      // Small delay before next batch to spread out requests
      await sleep(DELAY_BETWEEN_BATCHES_MS);
    } else {
      // If not successful and we broke out, stop processing further
      break;
    }
  }

  console.log('Done');
})();
