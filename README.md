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
- `services/db.js`: shared PostgreSQL pool, Cloud SQL settings, and schema initialization.
- `scripts/setup-cloud-sql.sh`: one-time Google Cloud resource setup.
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
starts automatically when PostgreSQL and `TYPESENSE_API_KEY` are configured. Configure
`TYPESENSE_URL` with your Typesense server address; it defaults to
`http://localhost:8108` for local development. PostgreSQL and Typesense must be
provided separately. The web server stays available while the worker retries
unavailable services. The PostgreSQL schema initializes at server startup even
when RSS is disabled or Typesense is not configured.

For local PostgreSQL, set `DATABASE_URL`. You can also initialize its schema without
starting the server:

```bash
npm run db:init
```

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
The deployment attaches Cloud SQL and injects its password from Secret Manager.
Configure the Typesense URL and API key separately on that Cloud Run service,
using Secret Manager for the API key. Deployment preserves other environment settings.

The deployment keeps at least one instance running with CPU available between
requests so RSS polling continues while the website is idle. This uses
[instance-based billing](https://docs.cloud.google.com/run/docs/configuring/billing-settings)
and incurs charges while idle. Each application instance runs a worker; database
conflicts on `(source, link)` and stable Typesense IDs deduplicate linked stories.

## Cloud SQL setup

Run the setup script once from an updated checkout in Google Cloud Shell before
deploying the new `cloudbuild.yaml`:

```bash
bash scripts/setup-cloud-sql.sh
```

The script creates billed resources in project `sfsu-hackathon-2026`:

- PostgreSQL 16 instance `sfhacksxgdg2026-db` in `us-west2`, using the Enterprise
  edition, `db-f1-micro` shared CPU, a 10 GB SSD that can grow, and daily backups.
  This small, single-zone instance suits initial development.
- Database and user `timeline`.
- Secret `sfhacksxgdg2026-db-password`, with a generated password that is never printed.
- Artifact Registry repository `cloud-run-source-deploy` in `us-west1`, if missing.

It grants the existing Cloud Run runtime service account Cloud SQL Client access
and access to this password secret. Reruns reuse the resources and password. Your
signed-in Cloud Shell account needs permission to enable APIs, create these
resources, and grant their IAM roles. The Cloud Build service account still needs
the build/deployment roles listed at the top of `cloudbuild.yaml`.

After setup, commit and push the project to the repository connected to your
Cloud Build trigger. A checkout in Cloud Shell can also submit a build immediately:

```bash
gcloud builds submit --project=sfsu-hackathon-2026 --config=cloudbuild.yaml .
```

Cloud Build attaches `sfsu-hackathon-2026:us-west2:sfhacksxgdg2026-db` to the
`sfhacksxgdg2026-git` service. The app connects through
`/cloudsql/sfsu-hackathon-2026:us-west2:sfhacksxgdg2026-db` using the existing `pg`
dependency. Data lives in Cloud SQL and survives app restarts and deployments;
an application file volume is not required. This follows Google's
[Cloud Run connection setup](https://docs.cloud.google.com/sql/docs/postgres/connect-run).

Look for `PostgreSQL database initialized.` in the Cloud Run logs after deployment.
RSS starts after initialization when its Typesense settings are configured. To
print the website URL:

```bash
gcloud run services describe sfhacksxgdg2026-git --project=sfsu-hackathon-2026 \
  --region=us-west2 --format='value(status.url)'
```

## License

MIT. See [LICENSE](LICENSE).
