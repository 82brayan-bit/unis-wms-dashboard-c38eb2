# UNIS WMS Dashboard

UNIS WMS operations dashboard with live service integrations.

## Files

- `index.html` — the dashboard UI; users sign in with their own access.
- `server.js` — the application server and constrained service proxies used by live integrations.

## Run locally

```bash
npm ci
PORT=8080 npm start
```

Then open `http://localhost:8080/`. The server listens on `0.0.0.0` for container and LAN access.

Run the automated checks with `npm test`.
