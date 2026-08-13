# Production optimization report

Measured on 2026-08-13 from checkpoint `3c10814131ba8ffc624dc6d31fefd447ea06f8dc`. Values are bytes. Gzip and Brotli use the same maximum-quality settings as `scripts/build.js` and `scripts/measure-assets.js`.

## Result

The 2,888,803-byte `facility-customer-locations.js` startup script was replaced by a 13-entry manifest and facility-specific ES modules. No facility data is requested on the login page. The selected facility loads once through native `import()`, concurrent requests are deduplicated, and a monotonically increasing request id prevents late facility responses from replacing the active selection. Facilities without a snapshot continue to use the existing live WMS fallback.

All 13 split customer and location contexts were compared with the checkpoint maps and match exactly.

| Initial page | Before | After production | Change |
| --- | ---: | ---: | ---: |
| Requests | 15 | 15 | No change |
| Identity response bytes | 4,625,039 | 1,559,863 | -3,065,176 (-66.27%) |
| Negotiated response bytes | 4,488,350 | 536,758 | -3,951,592 (-88.04%) |
| Facility chunks requested | 1 monolith | 0 | Removed from login path |

The negotiated measurement requests Brotli/gzip. The checkpoint server did not compress local static files, although the existing pinned Chart.js CDN response was Brotli-compressed. The after figure includes two Satoshi font files (257,168 bytes identity) and Chart.js (71,648 bytes Brotli). The measurement follows HTML and CSS references so the request graph is reproducible.

## Bundles

The before JavaScript total is the five checkpoint scripts loaded by the page. The after startup total is the five production scripts loaded before authentication; the all-JavaScript total also includes every lazy facility chunk, although only one selected chunk can enter a user session at a time.

| JavaScript scope | Raw | Gzip | Brotli |
| --- | ---: | ---: | ---: |
| Before startup | 3,941,281 | 577,239 | 333,956 |
| After startup | 878,307 | 220,327 | 176,054 |
| Startup reduction | 77.72% | 61.83% | 47.28% |
| After, including all lazy chunks | 3,787,096 | 552,911 | 321,992 |
| All-code reduction | 3.91% | 4.21% | 3.58% |

| CSS | Raw | Gzip | Brotli |
| --- | ---: | ---: | ---: |
| Before | 48,210 | 9,026 | 7,803 |
| After production | 45,905 | 8,360 | 7,330 |
| Reduction | 4.78% | 7.38% | 6.06% |

Largest production assets:

| Asset | Raw | Gzip | Brotli |
| --- | ---: | ---: | ---: |
| `lt-f1` lazy chunk | 2,459,868 | 271,597 | 113,207 |
| `dashboard-runtime` | 452,430 | 118,862 | 95,628 |
| `dashboard-modules` | 405,480 | 94,007 | 74,071 |
| `index.html` | 162,222 | 27,330 | 21,545 |
| `lt-f11` lazy chunk | 60,536 | 5,879 | 2,713 |
| `dashboard.css` | 39,700 | 7,043 | 6,193 |

Example selected-facility transfers are 3,136 Brotli bytes for `LT_F40` and 113,207 Brotli bytes for the much larger `LT_F1`. Hashed assets are immutable for one year; HTML remains `no-store`. The server negotiates prebuilt Brotli first, then gzip, then identity.

## Build and validation

The deterministic `dist/` build uses esbuild. Isolated facility ES modules receive full minification and tree-shaking. Legacy classic scripts receive syntax and whitespace minification while preserving identifiers and top-level globals required by inline event handlers and cross-file calls. Converting those scripts to modules or wrapping them would change their contract, so full tree-shaking is intentionally deferred.

Reproduce the checks:

```bash
npm ci
npm run build
npm test
npm run measure
npm run measure:dist
NODE_ENV=production PORT=4173 npm start
npm run measure:page -- http://127.0.0.1:4173/
MEASURE_ENCODING=identity npm run measure:page -- http://127.0.0.1:4173/
npm run smoke:browser -- http://127.0.0.1:4173/
```

Validation completed with 18 passing tests, JS syntax checks, two byte-identical consecutive builds, HTTP compression/cache/404/API-routing checks, and a dependency-free Chrome DevTools Protocol smoke. The browser smoke covered light and dark login/application themes, official logos, representative dashboard views, `LT_F40` and `LT_F42` lazy loading/deduplication, no missing assets or console exceptions, Employee Ownership present, and Active Users absent. Browser API requests were locally stubbed; no operational mutation was sent.

## Remaining opportunities

- `lt-f1` contains the overwhelming majority of lookup rows. Customer-level subchunks could reduce its selected-facility transfer, but that would require a second async boundary throughout scheduler and location workflows.
- The two legacy dashboard scripts still expose a broad global surface for inline handlers. Incremental ownership conversion to ES modules would unlock stronger dead-code elimination, but should be treated as a separate functional migration.
- The production dependency audit reports a high-severity advisory chain for the existing Nodemailer major version. `nodemailer` is used by the email route and cannot be removed; the available fix is a major upgrade to 9.x and should receive dedicated email regression testing.
