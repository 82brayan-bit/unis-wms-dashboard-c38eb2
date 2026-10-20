# PI setup-ticket correction

The PI calendar sends setup tickets through `/api/proxy/auth/ticket/tickets` to
Ticket System `POST /v1/iam/tickets`. This is separate from creating a WMS count.
Ticket ontology `a00d9` confirms the create and topic-form lookup contracts.
The previous arbitrary `{key, value}` entries caused `formId cannot be empty`.

Before an explicit creation attempt, `/api/pi-ticket-config?topicId=...` checks
the existing signed-in bearer with the canonical WMS user profile, verifies the
selected warehouse, and reads `GET /v1/open/forms/topic/{topicId}` without sending
the IAM bearer to that public endpoint. Only real form IDs with empty field
lists become `{formId, values: {}}`. Unavailable/malformed metadata or additional
fields block creation with a saved-draft error. No form IDs are hardcoded.
PI customer and warehouse context is appended to the outgoing message; saved
custom text and the approved message generators are unchanged.

The edit path no longer reads `rec` before initialization. Creation has one
explicit request, an in-flight guard, and skips an already-linked draft. Only
the successful Ticket response wrapper with a real ticket ID marks Created.
Ambiguous responses advise checking Ticket System before any manual retry.
Status updates belong to the originating warehouse. No existing drafts migrate.

## Runtime configuration

Before deployment, configure these nonsecret platform-resolved environment
values in the application runtime (not in committed `.env` files):

```
WMS_TENANT_ID=LT
WMS_API_BASE_URL=https://unis.item.com/api
TICKET_API_BASE_URL=https://unisticket.item.com/api/item-tickets
```

The WMS tenant/base URL must be configured as a pair. Ticket proxy creation and
metadata lookup now share the configured Ticket base URL and WMS tenant. Keep
the existing `TICKET_API_KEY` if the deployment requires it. Existing sign-in
and refresh remain unchanged. The server expects injected environment values;
it does not load `.env` automatically. Missing configuration blocks preflight.

## Verification and rollout

This change is isolated on production commit
`82877a53bfd1657a2555ec311c9964f0268a6963`, without unpublished Inventory/GIS code
or dependencies. All 127 tests, including ten focused in-memory PI tests, and
the production build passed. The approved PI template functions match production
exactly. A non-mutating live metadata read returned two topic-bound forms with
empty field lists for the existing default topic. This does not establish the
topic or warehouse of a browser-only failed draft.

The isolated production server returned 200 for the authenticated metadata
preflight, 401 without authentication, and 403 for an unauthorized warehouse.
Playwright verified login validation, the unchanged unsaved formal-template
button, visible 401 feedback, no PI draft storage changes, and no page errors
or mutation requests. Full signed-in ticket creation was not executed.

The post-deploy read-only check is an authenticated GET to
`/api/pi-ticket-config?topicId=<draft-topic-id>`, with the user's existing bearer
and selected authorized `x-facility-id`. Expect real `formEntries` or a clear
blocked response. Do not use this check to submit a ticket. A manual business
retry requires separate authorization and a duplicate check in Ticket System.
No live ticket creation/retry, email, WMS write, DB/schema change, push, or
deployment was performed while preparing this commit.
