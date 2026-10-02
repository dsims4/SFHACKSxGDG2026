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
- `.env.example`: local defaults and optional future service settings.

## Dependencies

The dependency versions and lockfile are copied from Trade Tank.

| Package | Purpose |
| --- | --- |
| `dotenv` | Local environment variables |
| `express` | HTTP server and routing |
| `nunjucks` | HTML templates |
| `helmet` | HTTP security headers |
| `express-rate-limit` | Future request rate limits |
| `pg` | Future PostgreSQL queries |
| `nodemailer` | Future email delivery |

Database, email, and rate-limit features are not wired into the starter.
Environment files, dependencies, and private keys are excluded from Git.

## Container

The included Dockerfile installs the locked production dependencies when built:

```bash
docker build -t sfhacksxgdg2026:local .
docker run --rm -p 3000:3000 sfhacksxgdg2026:local
```

## License

MIT. See [LICENSE](LICENSE).
