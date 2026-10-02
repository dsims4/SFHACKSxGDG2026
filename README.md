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
- `services/article-summaries.js`: article JSON, summary prompts, model response validation, and summary storage.
- `services/gemma.js`: authenticated vLLM requests and summary generation.
- `scripts/setup-cloud-sql.sh`: one-time Google Cloud resource setup.
- `scripts/setup-typesense.sh`: persistent Typesense VM and Cloud Run connection setup.
- `scripts/setup-gemma.sh`: Gemma 4 31B model cache and GPU Cloud Run deployment.
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
| `html-to-text` | Readable article text from feed HTML and XHTML |
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

The `content` column stores readable text: full `content:encoded` or Atom content
first, then a description/summary if the body is empty. HTML tags, tracking images,
scripts, and link URLs are removed while paragraphs and lists remain readable.
The original markup remains in `item_xml`, and images remain in `images`.
Headline-and-publisher snippets (such as the Google News Reuters feed) have no
article body, so content is empty and DBviewer shows "No article text in feed".
Publisher pages are not fetched; a feed that provides only a summary stays a summary.

Repeat polls update existing content and its location hints. To repair older rows
that are no longer in the live feeds, preview extraction from their saved XML:

```bash
npm run rss:repair-content
npm run rss:repair-content -- --apply
```

The default is a read-only dry run. Applying repairs keeps original XML, images,
titles, links, and IDs, skips malformed XML and concurrent changes, and refreshes
Typesense when configured. Rows without saved XML are cleaned from existing content.
Run the repair again if search indexing fails after PostgreSQL updates complete.

Optional environment settings are documented in `.env.example`. `RSS_ENABLED=false`
disables polling even when credentials are present. `RSS_ENABLED=true` requires
database credentials and fails startup if they are missing. Without database
credentials or an
explicit enable setting, the index page still runs and RSS is disabled.

Run the worker checks without live PostgreSQL, Typesense, or news services:

```bash
npm test
```

## Article summaries

Schema initialization creates `article_summaries` alongside `entries`. Each row
has its own ID, a unique `article_id` referencing `entries.id`, a `summary` JSONB
array of exactly five nonempty strings, a model identifier, and creation/update
timestamps. Deleting an article deletes its summary. Saving another summary for
the same article updates the existing row. The usual app startup or `npm run db:init`
applies this schema to a configured database.

`services/article-summaries.js` exports these backend helpers:

- `jsonifyArticle({ id, content })` returns a JSON string with `article_id` and
  `content`. IDs remain strings to preserve PostgreSQL bigint precision. The RSS
  parser has already extracted `entries.content`; the helper preserves plain text
  and any HTML/XML markup inside that JSON string, without parsing another XML tree.
- `buildSummaryPrompt(article)` includes that payload and requests exactly five
  factual bullet strings in a JSON array.
- `parseSummaryText(text)` parses model output into a JavaScript array, validates
  five nonempty strings, and rejects prose, wrong types, and double-encoded JSON.
- `saveArticleSummary(pool, { articleId, text, model })` validates the model's text
  and upserts the parsed summary into JSONB using parameterized SQL.
- `summarizeArticle(pool, articleId, { generateText, model })` reads the article,
  calls the supplied generator, and saves its `{ text: "[...JSON bullets...]" }`
  response. Generation or validation failures leave any existing summary intact.

Example using the Gemma 4 31B Instruct deployment:

```javascript
const { summarizeWithGemma } = require("./services/gemma");

const saved = await summarizeWithGemma(pool, "123");
console.log(saved.summary); // A JavaScript array, parsed from PostgreSQL JSONB.
```

The database value is `["First point", "Second point", "Third point", "Fourth point", "Fifth point"]`,
not a JSON string containing another JSON string. Summarization remains explicit;
RSS ingestion does not automatically submit articles to the GPU service.
No model endpoint or credentials are required to run the rest of the app.

## Gemma 4 on Cloud Run

Run the setup from an updated checkout in Cloud Shell with Node.js and gcloud
already available:

```bash
bash scripts/setup-gemma.sh
```

This follows [Google's Gemma 4 31B Cloud Run deployment guide](https://codelabs.developers.google.com/codelabs/cloud-run/cloud-run-gpu-rtx-pro-6000-gemma4-vllm).
It creates `sfhacksxgdg2026-gemma` in `us-central1` with one RTX PRO 6000 GPU
(96 GB VRAM), 20 CPUs, and 80 GiB of system RAM. These are separate resources
from the website. The service uses a maximum of one instance and scales to zero
when idle; GPU, CPU, and memory are billed while an instance runs. Model storage
continues to incur charges. GPU quota and capacity must be available in this region.
Cloud Run's [supported GPU regions and requirements](https://docs.cloud.google.com/run/docs/configuring/services/gpu)
determine this location and machine configuration.

The script first copies Google's public `google/gemma-4-31B-it` weights into
`gs://sfsu-hackathon-2026-gemma-models-us-central1/gemma-4-31B-it` using
`cloudbuild.gemma-model.yaml`. This build uses `--no-source`, a dedicated copy
identity, and Cloud Logging, so it does not require reading a source archive from
the build upload bucket. No Hugging Face token or local model download is needed.
Reruns synchronize the existing cache without deleting objects.

The GPU service runs Google's prebuilt `pytorch-vllm-serve:gemma4` container.
Run:ai Model Streamer reads the cached weights through Direct VPC egress and
Private Google Access. The runtime identity has read access to the model bucket;
the build identity can update its objects. The setup requires permission to manage
Cloud Run, service accounts and IAM bindings, networking, Cloud Storage, and builds.
The operator must be able to invoke the private model service for its smoke test.

The model is served as `google/gemma-4-31B-it`, with FP8 weights/cache, a 16,384-token
context, and four concurrent sequences. Its Cloud Run endpoint requires IAM
authentication. Only the application's identity is explicitly granted service
invocation access by this script. The script checks a real five-bullet inference
before setting `GEMMA_URL` and `GEMMA_MODEL` on the website. Future application
deployments preserve these environment settings; normal Git pushes do not rebuild
or redeploy the GPU service.

The JavaScript adapter requests a five-string JSON schema, disables thinking for
summaries, checks for a completed response, and validates the returned array.
It obtains a short-lived identity token from Google's metadata server when running
on Cloud Run. vLLM's `choices[0].message.content` is normalized to `{ text }` before
the summary is saved. No API key or npm dependency is required.

For a manual inference check from Cloud Shell, obtain a short-lived token without
printing it:

```bash
export GEMMA_URL="$(gcloud run services describe sfhacksxgdg2026-gemma \
  --project=sfsu-hackathon-2026 --region=us-central1 --format='value(status.url)')"
export GEMMA_ID_TOKEN="$(gcloud auth print-identity-token)"
node scripts/check-gemma.js
```

With the database connection/proxy configured as described above, summarize one
existing article by ID:

```bash
npm run summarize -- 123
unset GEMMA_ID_TOKEN
```

The token expires; refresh it for later local invocations. Cloud Run handles token
refresh by requesting a token for each model call. `GEMMA_TIMEOUT_MS` defaults to
900,000 milliseconds to allow for model cold starts. Startup and the first model
copy can take several minutes. Do not commit identity tokens into environment files.

If deployment fails, inspect its logs and verify the Cloud Run RTX PRO 6000 quota
for `us-central1`, then rerun the setup:

```bash
gcloud run services logs read sfhacksxgdg2026-gemma \
  --project=sfsu-hackathon-2026 --region=us-central1 --limit=80
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
