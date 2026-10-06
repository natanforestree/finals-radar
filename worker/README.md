# Ruby Radar Worker

A Cloudflare Worker that does two jobs:

- **Lobby log API.** It stores the "sweaty lobby" / "normal lobby" taps in
  Cloudflare D1. The API is specified in `../dev/DATA-CONTRACT.md`, section
  "Lobby log API".
- **Reliable timer.** Every 10 minutes it asks GitHub to run the `collect`
  workflow, because GitHub's own schedule drifts and sometimes drops runs.

## Visitor counter (public, no squad code)

A tiny daily counter for Reno Today. Two routes, open to anyone (the lobby
routes above still need the squad code):

- `POST /api/visit/:site` adds 1 to today's count for `:site` and answers
  `204` with no body. `:site` must be on the allowlist (`reno-today`), else `404`.
- `GET /api/visits/:site?days=N` (N from 1 to 31, default 7) returns
  `{"site": "reno-today", "days": [{"day": "2026-10-04", "count": 12}, ...]}`,
  oldest to newest, with missing days filled in as `0`.

"Day" is the America/Los_Angeles (Reno) date. CORS allows
`https://natanforestree.github.io`, `https://renotoday.com` and
`https://www.renotoday.com`.

**Privacy.** The `visits` table stores only `(site, day, count)`. No IP
addresses, user agents, cookies or referrers are read, stored or logged. The
visitor's own browser remembers "already counted today" in its localStorage;
that never leaves their device. Check the stored data with:

```sh
npx wrangler d1 execute ruby-radar --remote --command "SELECT * FROM visits ORDER BY day DESC LIMIT 10"
```

## Deploy (first time)

Run everything from this `worker/` folder, after `npm install`.

1. **Log in to Cloudflare** (Nathan does this himself; it opens a browser):

   ```sh
   npx wrangler login
   ```

2. **Create the database:**

   ```sh
   npx wrangler d1 create ruby-radar
   ```

   If it offers to add the database to your config, answer **no**, because
   `wrangler.toml` already has the `DB` binding. Copy the printed
   `database_id` into `wrangler.toml` in place of
   `00000000-0000-0000-0000-000000000000`.

3. **Create the table** (answer yes if it asks to confirm):

   ```sh
   npm run db:init
   ```

4. **Set the squad code**, which is what you and your friend type into the page:

   ```sh
   npx wrangler secret put SQUAD_CODE
   ```

5. **Set the GitHub token** used by the timer:

   ```sh
   npx wrangler secret put GITHUB_TOKEN
   ```

   Make the token at GitHub → Settings → Developer settings → Personal access
   tokens → **Fine-grained tokens** → Generate new token:
   - Repository access: **Only select repositories** → `natanforestree/finals-radar`
   - Repository permissions: **Actions: Read and write**, nothing else.
     GitHub adds "Metadata: Read-only" by itself; that's expected.
   - When it expires, the timer starts logging `HTTP 401`. Make a new token
     and run step 5 again.

   The same token also runs Reno Today (`natanforestree/reno-today`): on the
   :30 tick the Worker dispatches that repo's `collect.yml` too
   (`RENO_TODAY_REPO` / `RENO_TODAY_WORKFLOW` in wrangler.toml). The token
   needs both repos under "Repository access".

6. **Deploy:**

   ```sh
   npm run deploy
   ```

   On the first deploy Wrangler may ask you to pick a `workers.dev`
   subdomain.

7. **Copy the URL** it prints (`https://ruby-radar.<subdomain>.workers.dev`)
   into `docs/config.js`, without a trailing slash:

   ```js
   window.RUBY_RADAR_API = "https://ruby-radar.<subdomain>.workers.dev";
   ```

   Then check that the squad code works:

   ```sh
   curl -H "X-Squad-Code: <code>" https://ruby-radar.<subdomain>.workers.dev/api/ping
   # {"ok":true}
   ```

## Checking the timer

```sh
npx wrangler tail
```

This streams live logs. Every 10 minutes you should see a line like
`"*/10 * * * *" @ … - Ok`. A successful dispatch logs nothing else. A failed
one logs `dispatch <repo> failed: HTTP <status> <GitHub's message>`. The
usual causes are `401` (expired or wrong token) and `403`/`404` (the token
can't see the repo or lacks Actions write). If `GITHUB_TOKEN` isn't set, the
timer skips without logging anything.

On the GitHub side, dispatched runs show up as `workflow_dispatch`:

```sh
gh run list -R natanforestree/finals-radar --workflow collect.yml --event workflow_dispatch --limit 5
```

The workflow keeps its own GitHub schedule as a backup, so `collect` can run
up to about 12 times an hour. The workflow's `concurrency` group stops the
runs from overlapping.

## Exporting the lobby log

As JSON, through the API:

```sh
curl -s -H "X-Squad-Code: <code>" https://ruby-radar.<subdomain>.workers.dev/api/lobbies > lobbies.json
# only rows since a time: …/api/lobbies?since=1791221331
```

As SQL, straight from D1:

```sh
npx wrangler d1 export ruby-radar --remote --table=lobbies --output=lobbies.sql
```

For a quick look:

```sh
npx wrangler d1 execute ruby-radar --remote --command "SELECT * FROM lobbies ORDER BY t DESC LIMIT 20"
```

## Day-to-day

- **Change the squad code:** run `npx wrangler secret put SQUAD_CODE` again.
  It takes effect right away, and everyone re-enters the new code on the page.
- **Tests:** `npm test`. They use Node's built-in test runner with a fake
  in-memory D1 and need no Cloudflare login or workerd.
- **Run locally** (no login needed). Put the secrets in `.dev.vars`, which
  git ignores:

  ```sh
  npx wrangler d1 execute ruby-radar --local --file=schema.sql
  printf 'SQUAD_CODE=dev-code\n' > .dev.vars
  npx wrangler dev --test-scheduled
  curl -H "X-Squad-Code: dev-code" http://localhost:8787/api/ping
  curl "http://localhost:8787/__scheduled?cron=*/10+*+*+*+*"   # fire the timer once
  ```
