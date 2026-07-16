# Elitical Import Report

## Startup/demo data removed

- Removed the `src/data/jira.yaml` seed from the startup flow.
- Removed predefined sprint merging from the startup flow.
- Removed predefined epic preset loading from the startup flow.
- Removed cached local snapshot as a startup data source.
- Removed automatic remote GitHub snapshot loading as a startup data source.

The application now starts from `src/data/elitical-normalized.json`.

## UX Designer filter

- Target project code: `DES`
- Target project name: `UX Designer`
- Projects filtered out: `6`
- Sprints filtered out: `36`
- Dockets filtered out before hierarchy cleanup: `18`

## Remaining imported data

- Projects: `1`
- Sprints: `1`
- Epics: `27`
- Stories: `3`
- Jobs: `0`

## Hierarchy cleanup

- Stories dropped because no imported parent epic was present: `16`
- Jobs dropped because no imported parent story was present: `2`

No synthetic or dummy parent nodes were generated.
