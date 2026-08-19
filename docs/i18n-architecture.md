# Internationalization Architecture

## Application architecture

This repository is a classic browser single-page application, not React, Vue, or Next.js.

- `index.html` is the entry point and contains the login shell, existing header/sidebar, views, and persistent modal shells.
- `public/assets/js/dashboard-runtime.js` owns IAM login/session state, the hash-based `showView()` router, global facility context, facility switching, top-bar state, and charts.
- `public/assets/js/dashboard-modules.js` owns operational view state, read/write workflows, generated tables/forms/modals, and facility-scoped module rendering.
- `public/assets/js/facility-data-loader.js` owns lazy facility snapshots and stale-load rejection.
- `public/assets/js/theme.js` owns the light/dark preference.
- `public/assets/js/assistant.js` owns the assistant UI and request context.
- `server.js` serves the application and constrained service proxies; PostgreSQL remains optional and unchanged.
- `scripts/build.js` minifies and hashes browser assets, copies stable locale JSON, and emits compressed production files.

## Library and entry point

The application uses i18next. Its browser UMD build is vendored at `public/assets/vendor/i18next/i18next.min.js`, and the npm dependency lets Node tests exercise the same runtime.

`public/assets/js/i18n.js` exposes the single `window.ItemI18n` boundary. It is loaded before the dashboard runtime and feature modules. No page is duplicated per language and feature code contains no locale-specific branches.

Supported locales are `en`, `es`, `zh-CN`, `zh-TW`, `fr`, `de`, `pt`, `it`, `ja`, `ko`, `vi`, `fil`, `hi`, and `ar`.

## Catalog design

Catalogs live at `public/assets/locales/{locale}.json`. Every catalog has exact key parity with English and preserves the same interpolation placeholders.

- Shared semantic namespaces cover `brand`, `login`, `nav`, `quick`, `chrome`, `theme`, `common`, `status`, `views`, `assistant`, and `enums`.
- `modules` contains maintained semantic keys for Dashboard, Robot Count, Cycle Count, Inventory, Tasks, and Replenishment.
- `screens` covers stable copy in every existing operational view.
- `runtime` covers generated table/form/modal states and native alert, confirm, and prompt messages.

English is the default and fallback. Unsupported locale input normalizes to English. Missing locale files and missing translations resolve to English or an explicit English `defaultValue`; raw key strings are never shown.

## Rendering model

Shared static UI uses `data-i18n`, `data-i18n-placeholder`, `data-i18n-aria-label`, and `data-i18n-title`.

Generated operational UI uses these helpers:

- `ItemI18n.t()` for text and interpolation.
- `ItemI18n.html()` for escaped interpolation inside generated markup.
- `ItemI18n.enumLabel()` for display-only backend enum labels.
- `ItemI18n.preserveIdentifier()` as an explicit identity boundary.
- `ItemI18n.translateRuntimeString()` for cataloged native-dialog copy.

A bounded `MutationObserver` watches the application body but translates only known `.view` roots and generated dialog/toast/popover surfaces. GIS map cells remain a single canvas and never become translation or accessibility nodes.

Text-node and attribute descriptors are retained in weak maps. A bounded descriptor registry also remembers strings created after a non-English locale is active. This lets static copy, generated tables, interpolation, enum labels, charts, and open modals switch repeatedly without a reload or data fetch.

## Locale and direction state

The selected locale is stored per IAM identity:

```text
item-dashboard-locale:<encoded IAM user identity>
```

The login shell uses the `guest` namespace. After login, the namespace uses `payload.data.user_id`, falling back to `payload.data.user_name`. No profile-language contract exists, so no profile API, auth, or database change was made.

`html.lang` always matches the active locale. `html.dir` is `rtl` only for Arabic and `ltr` for all other locales. RTL CSS mirrors flow where appropriate while preserving usable tables, controls, sidebar behavior, identifiers, and numeric data.

## Selector

There is one language selector in the existing header beside theme/profile controls. It is a searchable combobox/listbox with keyboard navigation, selected state, accessible labels, an empty-result state, responsive sizing, and immediate switching. It does not add another header or navigation shell.

## Operational safety

Translation is presentation-only. The runtime never rewrites request objects, response objects, form values, IDs, comments, filenames, customer/facility/location/robot/task/ticket/yard/zone/SKU/UOM/LP values, API paths, request field names, or backend enum values.

Enum translation occurs only when rendering a label. Filters and payloads continue to use raw values such as `IN_PROGRESS`, `QTY_DIFF`, `PALLET_PICK`, and facility/customer IDs.

Language change handlers rerender cached presentation state and update charts with `chart.update('none')`; they do not call loaders or mutations.

The assistant receives `ItemI18n.responseLanguageInstruction()`, which requests the selected response language while requiring identifiers, codes, and request field names to remain exact.

## Build behavior

The optimizer minifies and hashes i18next and `i18n.js`. Locale JSON files are copied to `dist/assets/locales/` with stable names and `.gz`/`.br` variants, allowing the selected catalog to load without bundling all languages into every feature chunk.

## Adding a locale

1. Add `{code, name, nativeName}` to `LOCALES` in `public/assets/js/i18n.js`.
2. Add the locale code to `LOCALES` in `tests/i18n.test.js`.
3. Copy `public/assets/locales/en.json` to `<locale>.json`.
4. Translate every display value while preserving JSON keys, `{{placeholders}}`, protected identifiers, and backend/API values.
5. Add the locale to `RTL_LOCALES` only when it requires right-to-left layout.
6. Run `npm test`, `npm run build`, all JavaScript syntax checks, and `npm run smoke:browser -- http://127.0.0.1:<port>/` against a production server.

No routing, page duplication, auth change, or database migration is needed.
