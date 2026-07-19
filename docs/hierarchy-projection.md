# Hierarchy Projection Architecture

The canonical docket hierarchy is the highest-priority model in the application.

Canonical parent-child data must never be changed to satisfy a view, filter,
search, grouping, layout, or visualization. `parentId`, `sprintId`, and Elitical
identity fields remain source-of-truth values from the imported/cache model.

## Canonical Model

```text
Project
└── Sprint (view grouping only)
    └── Epic
        ├── Story
        │   └── Job
        └── Task
```

`parentId` relationships define the real hierarchy. Sprint membership is a view
grouping, not a replacement parent.

## Projection Rule

Every current and future view must consume `buildProjectedHierarchy(...)` before
rendering docket hierarchy. Views may choose which canonical items are visible,
but they must not build hierarchy directly from that filtered set.

When a view would hide or separate an ancestor from a visible child, the view must
request a render-only projection with `buildProjectedHierarchy(...)`.

The projection may create reference nodes for any docket type. Reference nodes:

- exist only in the rendering model
- are never persisted, synced, exported, saved, or sent to Elitical
- are never editable, draggable, or deletable
- preserve visual hierarchy without modifying canonical data

Reference Epic and Story nodes may expose the shared child-create action. That
action must resolve `sourceItemId` as the real parent docket and
`targetSprintId` as the displayed Sprint. New child dockets must send the
canonical parent ID as `parentId`/`epicId`/`storyId` as applicable and the
displayed Sprint ID as `sprintId`; the reference node ID must never leave the
projection/rendering layer.

## Shared Node/View Contract

All views must use the same shared docket/node presentation system for docket
boxes and their features. Views may filter, group, project, and arrange items,
but they must not duplicate docket card styling or action behavior locally.

The required flow is:

```text
Canonical Data -> buildProjectedHierarchy() -> View filtering/grouping/layout -> Shared Docket/Node Component
```

When a docket feature is added to the shared node/card component, every
applicable current and future view should receive that feature through the shared
component instead of a view-specific copy.

## Shared API

Use `src/utils/hierarchyProjection.js`:

```js
const { items } = buildProjectedHierarchy({
  items: visibleItems,
  allItems: canonicalItems,
  scopes: sprints,
});
```

`items` is the view's visible/filter/search result set. `allItems` is the
canonical docket list and is required so the projection can recover missing
ancestors as reference nodes without changing persisted data.

Future views such as timeline, calendar, kanban, reports, search, or dependency
views should use the same utility instead of implementing hierarchy-specific
reference logic locally.

Do not add view-local parent/child reconstruction, view-local ghost/reference
node builders, or filtered hierarchy fallbacks. If a view needs different
projection semantics, extend `buildProjectedHierarchy(...)` centrally.
