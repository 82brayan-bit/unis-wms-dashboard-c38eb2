# UNIS WMS Dashboard

UNIS WMS operations dashboard with live service integrations.

## Files

- `index.html` — the dashboard UI; users sign in with their own access.
- `server.js` — the application server and constrained service proxies used by live integrations.

## Live-presence collector

The dashboard reports live presence (verified IAM bearer token, per-tab session UUID, selected facility) to an optional tracker origin through `public/assets/js/presence-collector.js`, wired into the dashboard runtime lifecycle:

- Collection starts after a usable token exists and the async facility initialization resolves (`showDash` after `await populateFacilitySwitcher()`), reports facility changes only after `FACILITY_ID` is actually updated (`switchFacility`), and terminates best-effort before credentials are cleared on logout and failed reconnect.
- Heartbeats run every 30 seconds while the tab is visible, with a report on return-to-visible and keepalive termination on `pagehide`; repeated `showDash()` runs never create duplicate collectors or timers.
- The tracker origin is configured server-side with `PRESENCE_TRACKER_BASE_URL` and exposed to the browser via the same-origin, no-store `GET /api/runtime-config` endpoint (`{presenceTrackerBaseUrl}`). Empty or invalid values disable collection (no-op); the endpoint never exposes secrets.
- Collector failures, tracker downtime, invalid config, CORS or rejected ingestion never block WMS login, facility switching, logout, refresh, GIS or operational work — they produce concise developer warnings only.

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
