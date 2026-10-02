# SFHACKSxGDG2026

Starter web application adapted from Trade Tank, using Node.js 24, Express 5,
Nunjucks templates, and plain browser JavaScript and CSS. The index page runs
without a database or email service.

## Local development

With Node.js 24 available, install the locked dependencies:

```bash
npm ci
```

Copy the environment template to a local `.env` before customizing settings.
Git and Docker exclude `.env` and `.env.local`; only `.env.example` is tracked.

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
- `scripts/setup-typesense.sh`: persistent Typesense VM and Cloud Run connection setup.
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
The tracked `.env.example` contains connection settings and placeholders.

## Shared database access

Teammates connect to the same Cloud SQL `timeline` database through the
[Cloud SQL Auth Proxy](https://docs.cloud.google.com/sql/docs/postgres/connect-auth-proxy).
They need `gcloud` and the proxy available on their machine, plus Cloud SQL Client
access to project `sfsu-hackathon-2026` and Secret Manager Secret Accessor access to
secret `sfhacksxgdg2026-db-password`. The template alone does not grant cloud access.

After copying `.env.example` to `.env`, an authorized teammate can generate their
credentials before creating any manual `.env.local` overrides:

```bash
gcloud auth login
npm run db:env
```

The helper retrieves the existing database password from Secret Manager and writes
an ignored `.env.local` with owner-only file permissions. It does not print the
password or overwrite an existing `.env.local`.

Start the proxy in one terminal, using the same signed-in Google Cloud account:

```bash
cloud-sql-proxy --gcloud-auth --address=127.0.0.1 --port=5433 \
  sfsu-hackathon-2026:us-west2:sfhacksxgdg2026-db
```

In another terminal, run `npm start` and open `/viewer` or `/dbviewer`. Keep the proxy
running while the app uses the database. `npm run db:init` also reads `.env.local`.
Process environment variables take precedence over both files; `.env.local` takes
precedence over `.env`. Cloud Run continues to use its managed socket
and Secret Manager settings, because environment files are excluded from its image.

To grant a teammate access, a project administrator can replace `TEAMMATE_EMAIL`
with their Google account and run:

```bash
gcloud projects add-iam-policy-binding sfsu-hackathon-2026 \
  --member=user:TEAMMATE_EMAIL --role=roles/cloudsql.client --condition=None
gcloud secrets add-iam-policy-binding sfhacksxgdg2026-db-password \
  --project=sfsu-hackathon-2026 --member=user:TEAMMATE_EMAIL \
  --role=roles/secretmanager.secretAccessor
```

## RSS worker

`npm start` runs Express and the RSS worker in the same Node.js process. The worker
starts automatically when PostgreSQL is configured, using the same connection pool
as the database viewer. Cloud Run uses the attached Cloud SQL instance and the
password injected from Secret Manager; local development uses `DATABASE_URL`.

Typesense indexing is optional. Set `TYPESENSE_API_KEY` and configure
`TYPESENSE_URL` with your Typesense server address; it defaults to
`http://localhost:8108` for local development. PostgreSQL must be provided separately;
the Cloud SQL setup supplies it for Cloud Run. The web server stays available while
the worker retries
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
When Typesense is configured, current-year database rows are indexed after the
first poll. Stories are saved to PostgreSQL before indexing. A search outage does
not stop later database writes; indexing retries with a database backfill to repair
missed imports.

Optional environment settings are documented in `.env.example`. `RSS_ENABLED=false`
disables polling even when credentials are present. `RSS_ENABLED=true` requires
database credentials and fails startup if they are missing. Without database
credentials or an
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
settings with `--env-file .env.local` and use database and Typesense addresses reachable
from inside the container.

For the local PostgreSQL and Typesense stack, set `POSTGRES_PASSWORD` in your
ignored `.env` or shell, then run:

```bash
docker compose up --build
```

Compose requires that password and passes it to PostgreSQL and the app through
environment variables. The app's connection URL contains no password.

`cloudbuild.yaml` deploys this image to `sfhacksxgdg2026-git` in `us-west2`.
The deployment attaches Cloud SQL and injects its password from Secret Manager.
The deployment enables RSS polling. Run `scripts/setup-typesense.sh` to configure
the Typesense connection and Secret Manager API key. Deployment preserves those
environment variables, secrets, and Direct VPC egress settings on later pushes.

The deployment keeps at least one instance running with CPU available between
requests so RSS polling continues while the website is idle. This uses
[instance-based billing](https://docs.cloud.google.com/run/docs/configuring/billing-settings)
and incurs charges while idle. Each application instance runs a worker; database
conflicts on `(source, link)` and stable Typesense IDs deduplicate linked stories.

## Cloud Typesense setup

Run this once from an updated checkout in Google Cloud Shell:

```bash
bash scripts/setup-typesense.sh
```

The script creates a single `e2-standard-2` VM (2 vCPUs, 8 GiB RAM) in `us-west2-c`,
a 20 GB persistent search disk, a 10 GB boot disk, and a dedicated VPC subnet.
These resources and the VM's external IP incur charges while provisioned.
The external IP allows container image downloads; inbound search access is
restricted to the private subnet. The script requires permission to create these
resources, grant secret access, update Cloud Run, and connect to the VM through
IAP SSH. Project administrators already have broad resource permissions; IAP
access may require `roles/iap.tunnelResourceAccessor` for the operator.

The VM uses Container-Optimized OS with Docker already available. Its startup
script runs Typesense 27.1, matching the local Compose version, under systemd.
The API key is generated in Secret Manager as `sfhacksxgdg2026-typesense-key`.
The VM reads it with a dedicated service account and stores its runtime environment
file in memory with owner-only permissions. No key is stored in Git, YAML, or VM
metadata. Cloud Run receives the same key through Secret Manager.

After verifying `/health`, the setup connects the existing Cloud Run app using
[Direct VPC egress](https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc)
and `TYPESENSE_URL=http://10.89.0.10:8108`. Only traffic to private addresses uses
the VPC, so public RSS feeds remain reachable. The worker creates
`timeline_entries` and backfills current-year PostgreSQL rows on startup.
This configures indexing; it does not add a browser search interface.

The disk survives VM restarts and is retained if the VM is deleted. Rerunning the
setup reuses existing resources and the existing API key. This is a single-node
search service without automatic disk snapshots or high availability; PostgreSQL
remains the source of truth for rebuilding the index.

To check health or inspect startup failures:

```bash
gcloud compute ssh sfhacksxgdg2026-typesense \
  --project=sfsu-hackathon-2026 --zone=us-west2-c --tunnel-through-iap \
  --command='curl -fsS http://127.0.0.1:8108/health'
gcloud compute instances get-serial-port-output sfhacksxgdg2026-typesense \
  --project=sfsu-hackathon-2026 --zone=us-west2-c
gcloud compute ssh sfhacksxgdg2026-typesense \
  --project=sfsu-hackathon-2026 --zone=us-west2-c --tunnel-through-iap \
  --command='sudo journalctl -u sfhacks-typesense -n 80 --no-pager'
```

After startup-script changes, update VM metadata and apply the script without
formatting the existing search disk:

```bash
gcloud compute instances add-metadata sfhacksxgdg2026-typesense \
  --project=sfsu-hackathon-2026 --zone=us-west2-c \
  --metadata-from-file=startup-script=scripts/typesense-startup.sh
gcloud compute ssh sfhacksxgdg2026-typesense \
  --project=sfsu-hackathon-2026 --zone=us-west2-c --tunnel-through-iap \
  --command='sudo google_metadata_script_runner startup'
```

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
RSS starts after database initialization, including when Typesense is not configured. To
print the website URL:

```bash
gcloud run services describe sfhacksxgdg2026-git --project=sfsu-hackathon-2026 \
  --region=us-west2 --format='value(status.url)'
```

## License

MIT. See [LICENSE](LICENSE).
