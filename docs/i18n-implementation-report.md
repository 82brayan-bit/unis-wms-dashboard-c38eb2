# Global i18n Implementation Report

## 1. Scope

The existing UNIS WMS Inventory & Task Controller now has a centralized global i18n layer across shared chrome and all 20 operational views. No app, route, workflow, or duplicate language page was created.

## 2. Detected stack

The product is a classic JavaScript SPA with `index.html`, global browser modules, a custom hash router, Node serving/proxies, optional PostgreSQL support, and a custom production optimizer.

## 3. Library choice

i18next was selected because the app is framework-free. The browser build is vendored for deterministic production loading and the npm package is used by tests.

## 4. Supported locales

English, Spanish, Simplified Chinese, Traditional Chinese, French, German, Portuguese, Italian, Japanese, Korean, Vietnamese, Filipino, Hindi, and Arabic are supported.

## 5. Catalog result

All 14 JSON catalogs have exact key parity with English. Shared namespaces, maintained module keys, complete screen copy, generated runtime states, native dialogs, and display enum mappings are centralized.

## 6. Fallback behavior

English is default and fallback. Unsupported locales, unavailable catalog files, and unavailable translations resolve to English or an explicit English fallback, never a raw key.

## 7. Selector integration

One searchable language selector was added to the existing header beside theme/profile controls. It supports mouse, keyboard, search, current selection, accessible labels, and responsive layouts.

## 8. Persistence

Locale preference is stored in localStorage under a per-IAM-user namespace. The profile API was not changed because it has no confirmed language preference contract.

## 9. Immediate switching

Language changes update open views, generated tables/forms/modals, placeholders, ARIA labels, statuses, and Chart.js labels without reload. Cached renderers update presentation only and do not replay API operations.

## 10. RTL

Arabic sets `html lang="ar" dir="rtl"`. Every other locale uses `ltr`. Existing sidebar, header, tables, controls, responsive behavior, and operational identifiers remain usable.

## 11. Operational data safety

Facility/customer/location/robot/task/ticket/yard/zone/reference/SKU/UOM/LP identifiers, comments, API fields, request payloads, response data, and stored workflow records are not translated. Backend enums remain raw in state and requests; only display labels are localized.

## 12. Assistant behavior

Assistant context now includes the selected response language and an explicit instruction to preserve identifiers, codes, and request field names.

## 13. Build and assets

The existing optimizer hashes/minifies the runtime and copies stable locale JSON plus gzip/Brotli variants. No locale is duplicated into feature pages or facility chunks.

## 14. Verification coverage

Automated coverage checks catalog parity/placeholders, fallback/no-raw-key behavior, per-user persistence, selector search, English-Spanish-Chinese-English switching, Arabic RTL, generated DOM/runtime messages, enum display separation, identifier preservation, payload immutability, module coverage, production locale output, and read-only browser behavior.

## 15. Add another locale

1. Register the locale in `ItemI18n.LOCALES` in `public/assets/js/i18n.js`.
2. Register it in the test locale list in `tests/i18n.test.js`.
3. Copy `public/assets/locales/en.json` to the new locale filename.
4. Translate all values; preserve keys, `{{interpolation}}` names, IDs, codes, acronyms, API paths, and raw enum values.
5. Add it to `RTL_LOCALES` only if direction is right-to-left.
6. Run `node --check` for all JavaScript, `npm test`, `npm run build`, and the production browser smoke command.

There are no known untranslated application-owned UI areas. Live operational text supplied by WMS/HRM/GIS/ticket APIs, user comments, names, IDs, and upstream error detail intentionally remain unchanged.
