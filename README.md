# UNIS WMS Dashboard

UNIS WMS operations dashboard with live service integrations.

## Files

- `index.html` — the dashboard UI; users sign in with their own access.
- `server.js` — the application server and constrained service proxies used by live integrations.

## Run locally

```bash
npm ci
npm run build
PORT=8080 npm start
```

Then open `http://localhost:8080/`. The server listens on `0.0.0.0` for container and LAN access. When `dist/index.html` exists, the server uses the hashed, compressed production build. Without `dist/`, it serves the source files for local development.

Run the automated checks with `npm test`. Size reports are available through `npm run measure`, `npm run measure:dist`, and `npm run measure:page -- http://127.0.0.1:8080/`.

## Internationalization

The complete application uses i18next with 14 lazy locale catalogs, English fallback, a per-user browser preference, immediate switching, and Arabic RTL support. See [docs/i18n-architecture.md](docs/i18n-architecture.md) for the runtime and safety boundaries, and [docs/i18n-implementation-report.md](docs/i18n-implementation-report.md) for the completion report.
