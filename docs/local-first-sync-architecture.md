# Local-First Sync Architecture

This application is local-first. Normal create/edit saves update the local
canonical graph and persistent sync queue. They do not mutate Elitical.

## Data Flow

Canonical local data lives in `local-backend/cache/graph.json`.
Pending outbound mutations live in `local-backend/cache/sync-queue.json`.

Normal usage:

1. User creates or edits a docket.
2. The operation is validated locally.
3. The canonical local graph is updated immediately.
4. A pending queue operation is added or coalesced.
5. All views render from canonical data through `buildProjectedHierarchy()`.

Outbound sync:

1. User clicks `Sync to Elitical`.
2. The backend loads the persistent queue.
3. One SDK/authenticated Elitical session processes pending operations.
4. Successful operations are marked synced.
5. Failed operations remain pending as `sync-failed`.
6. Read-only reconciliation imports Elitical data.
7. Pending local changes are overlaid back onto the reconciled graph.

Read-only refresh/import must not push pending local mutations.

## Docket Sync Metadata

Existing imported dockets without `sync` metadata default conceptually to:

```json
{
  "status": "synced",
  "remoteId": "<docket id>"
}
```

New local dockets use stable local IDs:

```json
{
  "id": "local-docket-<uuid>",
  "sync": {
    "status": "pending-create",
    "remoteId": "",
    "localId": "local-docket-<uuid>",
    "pendingChanges": {}
  }
}
```

Remote-backed local edits use:

```json
{
  "sync": {
    "status": "pending-update",
    "remoteId": "<real Elitical docket id>",
    "pendingChanges": {
      "title": "New title"
    },
    "remoteBaseline": {
      "title": "Old title",
      "description": "Old description"
    }
  }
}
```

Implemented statuses:

- `synced`
- `pending-create`
- `pending-update`
- `sync-failed`

`pending-delete` is intentionally not implemented yet, but the queue schema
leaves room for it.

## Queue Schema

`local-backend/cache/sync-queue.json` contains:

```json
{
  "version": 1,
  "operations": [
    {
      "operationId": "queue-<uuid>",
      "entityType": "docket",
      "operation": "create",
      "localId": "local-docket-<uuid>",
      "remoteId": "",
      "docketType": "story",
      "payload": {},
      "changes": {},
      "createdAt": "",
      "updatedAt": "",
      "status": "pending-create",
      "attempts": 0,
      "lastError": ""
    }
  ],
  "localToRemote": {},
  "updatedAt": ""
}
```

## Queue Compaction

Remote-backed docket updates are coalesced by docket:

- save title to `B`
- save title to `C`
- save title to `Final`

The queue keeps one pending update with:

```json
{ "title": "Final" }
```

If a docket is still `pending-create`, later title/description edits merge into
the create payload. The queue must not contain `CREATE + UPDATE` for the same
unsynced docket.

## Local ID Strategy

The app uses stable local canonical IDs for unsynced dockets:

```txt
local-docket-<uuid>
```

Reference node IDs and Orphan Sprint IDs are render-only and are never used as
canonical local IDs or remote mutation IDs.

After remote create succeeds, the current implementation replaces the local ID
with the real Elitical ID transactionally in the graph and rewrites child parent
references. The queue also stores `localToRemote` so dependent operations can be
resolved during the same sync run.

## Dependency Ordering

Pending creates are ordered by local parent depth:

```txt
Epic -> Story -> Job
Epic -> Task
```

Child creates whose local parent has not produced a remote ID are blocked and
marked failed. The sync engine must never guess a remote parent ID.

## Remote API Boundary

Normal Save/Create does not call Elitical.

Only `Sync to Elitical` may call:

- existing confirmed Create Epic/Story/Task/Job APIs
- confirmed Title update API
- confirmed Description update API

Confirmed update endpoints:

```txt
PUT /api/1/Docket/title?utResCode=200
PUT /api/1/Docket/description?utResCode=200
```

Description payload uses `descr`.

Unconfirmed update fields are not sent remotely:

- Status
- Priority
- Category
- Story Points
- Assignee
- Sprint
- Parent

## Reconciliation And Conflict Safety

After outbound sync, the backend performs read-only Elitical reconciliation.
Pending local changes are overlaid onto the imported graph before saving cache,
so failed or unsynced user changes are not silently destroyed.

Full conflict resolution UI is future work. Current foundation preserves:

- local working value
- pending changes
- remote baseline at the time of local edit

## Validation

Known centralized validation is in `validateDocketOperation()`:

- title is required
- Epic can be created in project/sprint context
- Story and Task require an Epic parent
- Job requires a Story parent
- `virtual-orphan-sprint` is never persisted as a real sprint ID
- only Title/Description are sync-enabled updates in this phase

Future validation extensions:

- closed Sprint restrictions
- allowed state transitions
- assignee rules
- Story Point rules
- hierarchy movement restrictions
- mandatory field parity with Elitical

Closed Sprint rule parity is not confirmed yet. Imported sprint records expose
state/date-like fields, but native Elitical behavior still needs research.

## View Contract

All views must follow:

```txt
Canonical Local Data
-> buildProjectedHierarchy()
-> view filtering/grouping/layout
-> shared JiraNode/card presentation
```

Views must not maintain separate queue state, ghost builders, or docket action
logic. Reference nodes may display inherited sync state but remain render-only.

## Future Work

Delete can be added as a queue operation with dependency checks and delayed
remote mutation. Worklog sync can plug into the same queue with docket local ID
resolution before upload.
