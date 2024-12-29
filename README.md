In some cases, you may find that you need to bulk-delete many posts from your Bluesky account. For example, perhaps you shared many links to a particular domain and now you want to remove them en masse. Doing this manually would be tedious. Fortunately, we can automate the process using a script written in TypeScript.
blog post about it https://blog.rmendes.net/2024/12/15/how-to-bulk.html

This script leverages the official `@atproto/api` package to:
1. Log into your Bluesky account.
2. Fetch all posts that match certain criteria (e.g., containing a specific domain in their facets, embeds, or entities).
3. Delete them in batches while respecting and reacting to rate limits.


## Key Features


- **Domain-based Filtering:**  
  The script identifies posts containing a specific domain by checking:
  - Facets with `app.bsky.richtext.facet#link`.
  - External embeds with `app.bsky.embed.external`.
  - Legacy entities with `type: link`.
  
- **Rate Limit Management (Proactive):**  
  The Bluesky PDS imposes a rate limit of 5000 deletion points per hour. Deletions cost 1 point each. The script proactively monitors how many deletions it has performed within the current hour. When it approaches the limit, it waits until the hour has elapsed before continuing.


- **Rate Limit Management (Fallback):**  
  If the script ever hits a `429 Rate Limit Exceeded` error, it will parse the `ratelimit-reset` header and wait until the given time before retrying that batch of deletions. This ensures that if the proactive limit check is not enough, the script still handles the server’s instructions gracefully.


- **Batch Operations and Delays:**  
  To avoid rapid-fire requests, the script:
  - Performs deletions in configurable batch sizes (default: 200 per batch).
  - Waits a short delay between batches to spread requests out over time.


## Prerequisites


- **Node.js and npm:**  
  Ensure you have a recent version of Node.js installed.


- **Install Dependencies:**
  ```bash
  npm install @atproto/api p-ratelimit
  ```
- **Use a CommonJS Approach:**
If you simply want to run ts-node in a CommonJS environment (the traditional way):

Install ts-node and typescript locally (if not already):
  ```bash
npm install --save-dev ts-node typescript
  ```
Set "module": "commonjs" (and "target": "ES2020" or later) in your tsconfig.json. For example:
  ```bash
    {
      "compilerOptions": {
        "target": "ES2020",
        "module": "commonjs",
        "strict": true,
        "esModuleInterop": true,
        "skipLibCheck": true,
        "forceConsistentCasingInFileNames": true
      }
    }
  ```
## Credentials


Replace your-handle and your-password in the script with your Bluesky account credentials. You should only do this with an account you control and trust running scripts on.


## Running the Script


Save the script below as bluesky-sweep.ts.


Run it using:


```bash
npx ts-node bluesky-sweep.ts
```
## Configuration Parameters
- TARGET_DOMAIN: Set this to the domain you want to search for in your posts.
- DELETES_PER_BATCH: Number of posts per deletion batch.
- MAX_DELETES_PER_HOUR: Maximum deletions allowed per hour (5000 is the current default from Bluesky).
- SAFE_MARGIN: A buffer to start waiting before hitting the exact limit.
- DELAY_BETWEEN_BATCHES_MS: Milliseconds to wait between each batch.
