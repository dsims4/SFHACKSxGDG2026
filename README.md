# SFHACKSxGDG2026

Starter web application adapted from Trade Tank, using Node.js 24, Express 5,
Nunjucks templates, and plain browser JavaScript and CSS. The index page runs
without a database or email service.

## Local development

With Node.js 24 available, install the locked dependencies:

```bash
npm ci
```

Optionally copy `.env.example` to `.env` to customize the port or environment:

```bash
cp .env.example .env
```

Start the server:

```bash
npm start
```

Open http://localhost:3000. For automatic server restarts when files change:

```bash
npm run dev
```

## Project structure

- `server.js`: Express, Nunjucks, security headers, static files, and error handling.
- `routes/public.js`: index-page route.
- `views/`: page templates, shared layout, and head partial.
- `public/css/`: shared styles and index-page layout.
- `public/js/app.js`: shared browser API-response helper.
- `rss-builder/`: JavaScript RSS worker, feed list, geographic hints, and SQL schema.
- `.env.example`: local defaults and optional future service settings.

## Dependencies

The web dependencies were copied from Trade Tank. The RSS worker shares the same
package manifest and lockfile.

| Package | Purpose |
| --- | --- |
| `dotenv` | Local environment variables |
| `express` | HTTP server and routing |
| `nunjucks` | HTML templates |
| `helmet` | HTTP security headers |
| `express-rate-limit` | Future request rate limits |
| `pg` | RSS story storage in PostgreSQL |
| `rss-parser` | RSS and Atom feed parsing |
| `nodemailer` | Future email delivery |

Email and rate-limit features are not wired into the starter.
Environment files, dependencies, and private keys are excluded from Git.

## RSS worker

`npm start` runs Express and the RSS worker in the same Node.js process. The worker
starts automatically when `DATABASE_URL` and `TYPESENSE_API_KEY` are set. Configure
`TYPESENSE_URL` with your Typesense server address; it defaults to
`http://localhost:8108` for local development. PostgreSQL and Typesense must be
provided separately. The web server stays available while the worker retries
unavailable services.

The worker reads `rss-builder/feeds.json`, polls every 600 seconds, and fetches up
to 10 feeds concurrently. It preserves the Python worker's current-year filtering,
source exclusions, location hints, PostgreSQL table, and Typesense document IDs.
Existing current-year database rows are indexed on startup. Imports are retried
through a database backfill after a failed cycle.

Optional environment settings are documented in `.env.example`. `RSS_ENABLED=false`
disables polling even when credentials are present. `RSS_ENABLED=true` requires the
credentials and fails startup if they are missing. Without credentials or an
explicit enable setting, the index page still runs and RSS is disabled.

Run the worker checks without live PostgreSQL, Typesense, or news services:

```bash
npm test
```

## Container

The included Dockerfile installs the locked production dependencies when built:

```bash
docker build -t sfhacksxgdg2026:local .
docker run --rm -p 3000:3000 sfhacksxgdg2026:local
```

The root image includes the RSS worker and all its dependencies. There is no
separate Python image or worker build. To enable RSS in the container, pass its
settings with `--env-file .env` and use database and Typesense addresses reachable
from inside the container.

`cloudbuild.yaml` deploys this image to `sfhacksxgdg2026-git` in `us-west2`.
Configure the RSS credentials and Typesense URL on that Cloud Run service, using
Secret Manager for secrets. Deployment preserves existing environment settings.

The deployment keeps at least one instance running with CPU available between
requests so RSS polling continues while the website is idle. This uses
[instance-based billing](https://docs.cloud.google.com/run/docs/configuring/billing-settings)
and incurs charges while idle. Each application instance runs a worker; database
conflicts on `(source, link)` and stable Typesense IDs deduplicate linked stories.

## License

MIT. See [LICENSE](LICENSE).
