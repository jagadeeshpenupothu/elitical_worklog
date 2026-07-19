import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalSyncQueueService } from "../local-backend/services/LocalSyncQueueService.mjs";
import {
  eliticalWorklogDateMillis,
  millisFromWorklogDate,
  worklogDatesSemanticallyMatch,
  worklogUpdateDatesConfirm,
} from "../src/services/elitical/worklogReconciliation.js";

const serverSource = await fs.readFile(new URL("../local-backend/server.mjs", import.meta.url), "utf8");
const clientSource = await fs.readFile(
  new URL("../src/services/elitical/client/EliticalClient.ts", import.meta.url),
  "utf8"
);
const providerSource = await fs.readFile(
  new URL("../src/services/elitical/provider/EliticalProvider.ts", import.meta.url),
  "utf8"
);
const appSource = await fs.readFile(new URL("../src/App.jsx", import.meta.url), "utf8");

function extractFunction(source, name, { async = false } = {}) {
  const marker = `${async ? "async " : ""}function ${name}(`;
  const start = source.indexOf(marker);

  assert.notEqual(start, -1, `${name} must exist.`);

  const paramsEnd = source.indexOf(")", start);
  const bodyStart = source.indexOf("{", paramsEnd);
  let depth = 0;

  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }

  throw new Error(`Unable to extract ${name}.`);
}

function outboundPayload(operation, docketId) {
  const basePayload = operation.operation === "update"
    ? {
        ...(operation.remoteBaseline || {}),
        ...(operation.payload || {}),
        ...(operation.changes || {}),
      }
    : {
        ...(operation.payload || {}),
        ...(operation.changes || {}),
      };
  const id = operation.remoteId || basePayload.id || "";

  return {
    ...basePayload,
    id,
    docketId,
  };
}

function updateDto(payload) {
  const totalMinutes = Number(payload.timeMinutes ?? payload.durationMinutes ?? 0);
  const hour = payload.hour !== undefined ? Number(payload.hour) : Math.floor(totalMinutes / 60);
  const min = payload.min !== undefined && payload.min !== null ? Number(payload.min) : totalMinutes % 60;
  const worklogDate = eliticalWorklogDateMillis(payload.worklogDate ?? payload.date);

  return {
    id: payload.id || payload.worklogId || "",
    docketId: payload.docketId || "",
    comment: payload.comment || payload.description || payload.note || "",
    hour,
    min,
    worklogDate: Number.isFinite(worklogDate) && worklogDate > 0 ? worklogDate : null,
  };
}

function positiveDurationMinutes(value = {}) {
  const explicit = Number(value.timeMinutes ?? value.durationMinutes ?? value.loggedMinutes ?? 0);

  if (Number.isFinite(explicit) && explicit > 0) return Math.round(explicit);

  const hours = Number(value.hour ?? value.hours ?? value.loggedHours ?? value.duration ?? 0);
  const minutes = Number(value.min ?? value.minutes ?? 0);
  const total = Math.round((Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0));

  return total > 0 ? total : 0;
}

function confirmedUpdatedWorklogForTest(operation, outboundWorklog, updatedWorklog, remoteDocketId, remoteWorklogId) {
  const outboundDuration = positiveDurationMinutes(outboundWorklog);
  const remoteDuration = positiveDurationMinutes(updatedWorklog);
  const durationChangeWasSent = ["hour", "min", "timeMinutes", "durationMinutes", "minutes"].some((field) =>
    Object.prototype.hasOwnProperty.call(operation.changes || {}, field)
  );
  const duration = durationChangeWasSent || remoteDuration === 0
    ? outboundDuration
    : remoteDuration || outboundDuration;
  const durationFields = duration > 0
    ? {
        hour: Math.floor(duration / 60),
        min: duration % 60,
        timeMinutes: duration,
        durationMinutes: duration,
      }
    : {};

  return {
    ...(operation.remoteBaseline || {}),
    ...(operation.payload || {}),
    ...(operation.changes || {}),
    ...(updatedWorklog || {}),
    ...durationFields,
    id: updatedWorklog?.id || updatedWorklog?.worklogId || remoteWorklogId,
    docketId: updatedWorklog?.docketId || remoteDocketId,
    worklogDate:
      Object.prototype.hasOwnProperty.call(operation.changes || {}, "worklogDate") ||
      Object.prototype.hasOwnProperty.call(operation.changes || {}, "date")
        ? outboundWorklog.worklogDate || outboundWorklog.date
        : updatedWorklog?.worklogDate || updatedWorklog?.date || outboundWorklog.worklogDate || outboundWorklog.date,
  };
}

function modalDuration(worklog, item = {}) {
  if (!worklog) return positiveDurationMinutes(item);

  return (
    positiveDurationMinutes(worklog) ||
    positiveDurationMinutes(item) ||
    positiveDurationMinutes(worklog.sync?.remoteBaseline)
  );
}

const worklogPayloadForRemote = extractFunction(serverSource, "worklogPayloadForRemote");
const confirmedWorklogUpdateResult = extractFunction(serverSource, "confirmedWorklogUpdateResult");
const confirmedUpdatedWorklog = extractFunction(serverSource, "confirmedUpdatedWorklog");
const syncPendingToElitical = extractFunction(serverSource, "syncPendingToElitical", { async: true });
const mergeWorklogIntoGraph = extractFunction(serverSource, "mergeWorklogIntoGraph");
const normalizedWorklogCacheEntry = extractFunction(serverSource, "normalizedWorklogCacheEntry");

assert.match(worklogPayloadForRemote, /operation\.operation === "update"/);
assert.match(worklogPayloadForRemote, /\.\.\.\(operation\.remoteBaseline \|\| \{\}\)/);
assert.match(worklogPayloadForRemote, /\.\.\.\(operation\.payload \|\| \{\}\)/);
assert.match(worklogPayloadForRemote, /\.\.\.\(operation\.changes \|\| \{\}\)/);
assert.match(confirmedWorklogUpdateResult, /worklogUpdateDatesConfirm/);
assert.match(confirmedWorklogUpdateResult, /acceptedChanges/);
assert.match(confirmedWorklogUpdateResult, /rejectedFields/);
assert.match(confirmedWorklogUpdateResult, /remoteBaseline/);
assert.match(confirmedUpdatedWorklog, /const outboundDuration = positiveWorklogDurationMinutes\(outboundWorklog\)/);
assert.match(confirmedUpdatedWorklog, /const remoteDuration = positiveWorklogDurationMinutes\(updatedWorklog\)/);
assert.match(confirmedUpdatedWorklog, /const durationChangeWasSent = \[/);
assert.match(confirmedUpdatedWorklog, /const preserveOutboundDuration = outboundDuration > 0 && \(remoteDuration === 0 \|\| durationChangeWasSent\)/);
assert.match(confirmedUpdatedWorklog, /const dateChangeWasSent =/);
assert.match(normalizedWorklogCacheEntry, /const totalMinutes = positiveWorklogDurationMinutes\(payload\)/);
assert.match(syncPendingToElitical, /const outboundWorklog = \{/);
assert.match(syncPendingToElitical, /const confirmation = confirmedWorklogUpdateResult\(/);
assert.match(syncPendingToElitical, /confirmedUpdatedWorklog\(/);
assert.match(syncPendingToElitical, /acceptedChanges: confirmation\.acceptedChanges/);
assert.match(syncPendingToElitical, /pendingFields: Object\.keys\(remainingChanges\)/);
assert.match(syncPendingToElitical, /await mergeSyncedWorklogIntoCache\(\s*confirmedWorklog,/s);
assert.match(syncPendingToElitical, /markGraphWorklogSynced\(graph, operation\.localId, remoteWorklogId, confirmedWorklog, \{/);
assert.doesNotMatch(serverSource, /\+5:30|-5:30|19800000|46800000/);
assert.doesNotMatch(clientSource, /\+5:30|-5:30|19800000|46800000/);
assert.doesNotMatch(mergeWorklogIntoGraph, /status: item\.sync\?\.status === "pending-create" \? "pending-create" : "pending-update"/);
assert.match(clientSource, /eliticalWorklogDateMillis\(payload\.worklogDate \?\? payload\.date\)/);
assert.match(clientSource, /worklogDate is required to update an Elitical worklog/);
assert.match(clientSource, /hour and min are required to update an Elitical worklog/);
assert.match(providerSource, /function worklogMinutes\(worklog: Worklog\): number/);
assert.match(providerSource, /worklog\.timeMinutes/);
assert.match(providerSource, /worklog\.durationMinutes/);
assert.match(appSource, /function durationMinutesForWorklogDraft/);
assert.match(appSource, /durationFromHourMinute\(worklog\.sync\?\.remoteBaseline\)/);
assert.match(appSource, /<TextField\s+label="Worklog Date"/);
assert.match(appSource, /<TextField\s+label="Hours"/);
assert.match(appSource, /<TextField\s+label="Minutes"/);
assert.match(appSource, /<TextAreaField\s+label="Comment"/);

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "elitical-worklog-update-"));
const queue = new LocalSyncQueueService({ cacheDir: tmpDir });
const baseline = {
  comment: "old comment",
  worklogDate: 1783881000000,
  hour: 3,
  min: 0,
};

await queue.enqueueWorklogUpdate({
  worklog: {
    id: "remote-worklog-1",
    docketId: "remote-docket-1",
    comment: "old comment",
    worklogDate: baseline.worklogDate,
    hour: baseline.hour,
    min: baseline.min,
    sync: {
      status: "synced",
      remoteId: "remote-worklog-1",
      remoteBaseline: baseline,
    },
  },
  changes: {
    comment: "first local edit",
  },
});
await queue.enqueueWorklogUpdate({
  worklog: {
    id: "remote-worklog-1",
    docketId: "remote-docket-1",
    comment: "first local edit",
    worklogDate: baseline.worklogDate,
    hour: baseline.hour,
    min: baseline.min,
    sync: {
      status: "pending-update",
      remoteId: "remote-worklog-1",
      remoteBaseline: baseline,
    },
  },
  changes: {
    comment: "latest local edit",
  },
});

let loaded = await queue.load();
let updates = loaded.operations.filter((operation) =>
  operation.entityType === "worklog" && operation.operation === "update"
);
assert.equal(updates.length, 1);
assert.equal(updates[0].changes.comment, "latest local edit");
assert.deepEqual(updates[0].remoteBaseline, baseline);

const outbound = outboundPayload(updates[0], "remote-docket-1");
const dto = updateDto(outbound);
assert.deepEqual(dto, {
  id: "remote-worklog-1",
  docketId: "remote-docket-1",
  comment: "latest local edit",
  hour: 3,
  min: 0,
  worklogDate: 1783881000000,
});

const confirmedFromDefaultedRemote = confirmedUpdatedWorklogForTest(
  updates[0],
  outbound,
  {
    id: "remote-worklog-1",
    docketId: "remote-docket-1",
    comment: "latest local edit",
    worklogDate: 1783834200000,
    hour: 0,
    min: 0,
    timeMinutes: 0,
    durationMinutes: 0,
  },
  "remote-docket-1",
  "remote-worklog-1"
);
assert.equal(confirmedFromDefaultedRemote.hour, 3);
assert.equal(confirmedFromDefaultedRemote.min, 0);
assert.equal(confirmedFromDefaultedRemote.timeMinutes, 180);
assert.equal(confirmedFromDefaultedRemote.durationMinutes, 180);
assert.equal(confirmedFromDefaultedRemote.comment, "latest local edit");

const confirmedFromExplicitMinutes = confirmedUpdatedWorklogForTest(
  updates[0],
  outbound,
  {
    id: "remote-worklog-1",
    docketId: "remote-docket-1",
    comment: "latest local edit",
    worklogDate: 1783834200000,
    timeMinutes: 150,
    durationMinutes: 150,
  },
  "remote-docket-1",
  "remote-worklog-1"
);
assert.equal(confirmedFromExplicitMinutes.hour, 2);
assert.equal(confirmedFromExplicitMinutes.min, 30);
assert.equal(confirmedFromExplicitMinutes.timeMinutes, 150);

const explicitDurationChange = confirmedUpdatedWorklogForTest(
  {
    ...updates[0],
    changes: {
      comment: "new 2:30 comment",
      hour: 2,
      min: 30,
    },
  },
  {
    ...outbound,
    comment: "new 2:30 comment",
    hour: 2,
    min: 30,
  },
  {
    id: "remote-worklog-1",
    docketId: "remote-docket-1",
    comment: "new 2:30 comment",
    worklogDate: 1783834200000,
    hour: 3,
    min: 0,
    timeMinutes: 180,
  },
  "remote-docket-1",
  "remote-worklog-1"
);
assert.equal(explicitDurationChange.hour, 2);
assert.equal(explicitDurationChange.min, 30);
assert.equal(explicitDurationChange.timeMinutes, 150);
assert.equal(explicitDurationChange.comment, "new 2:30 comment");

const arbitraryDurationChange = confirmedUpdatedWorklogForTest(
  {
    ...updates[0],
    remoteBaseline: {
      ...baseline,
      hour: 1,
      min: 0,
    },
    changes: {
      comment: "new 4:45 comment",
      hour: 4,
      min: 45,
    },
  },
  {
    ...outbound,
    comment: "new 4:45 comment",
    hour: 4,
    min: 45,
  },
  {
    id: "remote-worklog-1",
    docketId: "remote-docket-1",
    comment: "new 4:45 comment",
    hour: 0,
    min: 0,
  },
  "remote-docket-1",
  "remote-worklog-1"
);
assert.equal(arbitraryDurationChange.hour, 4);
assert.equal(arbitraryDurationChange.min, 45);
assert.equal(arbitraryDurationChange.timeMinutes, 285);

const explicitDateChange = confirmedUpdatedWorklogForTest(
  {
    ...updates[0],
    changes: {
      comment: "new date comment",
      worklogDate: 1784053800000,
    },
  },
  {
    ...outbound,
    comment: "new date comment",
    worklogDate: 1784053800000,
  },
  {
    id: "remote-worklog-1",
    docketId: "remote-docket-1",
    comment: "new date comment",
    worklogDate: 1783834200000,
    hour: 3,
    min: 0,
  },
  "remote-docket-1",
  "remote-worklog-1"
);
assert.equal(explicitDateChange.worklogDate, 1784053800000);
assert.equal(explicitDateChange.comment, "new date comment");

assert.equal(
  modalDuration({
    timeMinutes: 0,
    durationMinutes: 0,
    hour: 0,
    min: 0,
    sync: {
      remoteBaseline: {
        hour: 3,
        min: 0,
      },
    },
  }),
  180
);
assert.equal(
  modalDuration({
    hour: 2,
    min: 15,
  }),
  135
);
assert.equal(
  modalDuration({
    timeMinutes: 0,
    durationMinutes: 0,
    hour: 0,
    min: 0,
  }),
  0
);

await queue.markUpdateFieldsSynced(updates[0].operationId, {
  localId: "remote-worklog-1",
  remoteId: "remote-worklog-1",
  acceptedChanges: updates[0].changes,
});
loaded = await queue.load();
updates = loaded.operations.filter((operation) =>
  operation.entityType === "worklog" && operation.operation === "update"
);
assert.equal(updates[0].status, "synced");
assert.deepEqual(updates[0].changes, {});

await queue.enqueueWorklogUpdate({
  worklog: {
    id: "remote-worklog-2",
    docketId: "remote-docket-1",
    comment: "old comment",
    worklogDate: baseline.worklogDate,
    hour: baseline.hour,
    min: baseline.min,
    sync: {
      status: "synced",
      remoteId: "remote-worklog-2",
      remoteBaseline: baseline,
    },
  },
  changes: {
    comment: "bad update",
  },
});
loaded = await queue.load();
const failedOperation = loaded.operations.find((operation) =>
  operation.entityType === "worklog" &&
  operation.operation === "update" &&
  operation.localId === "remote-worklog-2"
);
await queue.markOperationFailed(failedOperation.operationId, { status: 400, message: "Elitical request failed (400):" });
const summary = await queue.summary();
const failedSummary = summary.operations.find((operation) => operation.operationId === failedOperation.operationId);
assert.equal(failedSummary.classification.actionability, "mutation-actionable");
assert.equal(failedSummary.classification.retryable, true);
assert.equal(failedSummary.classification.reconciliationActionable, false);

const firstCycle = updateDto(outboundPayload({
  operation: "update",
  remoteId: "remote-worklog-date",
  payload: {},
  changes: { comment: "cycle one" },
  remoteBaseline: baseline,
}, "remote-docket-1"));
const secondCycle = updateDto(outboundPayload({
  operation: "update",
  remoteId: "remote-worklog-date",
  payload: {},
  changes: { comment: "cycle two" },
  remoteBaseline: {
    ...baseline,
    comment: "cycle one",
  },
}, "remote-docket-1"));
assert.equal(firstCycle.worklogDate, baseline.worklogDate);
assert.equal(secondCycle.worklogDate, baseline.worklogDate);

const nativeContractDate = "2026-07-14";
const nativeContractMillis = 1783987200000;
assert.equal(eliticalWorklogDateMillis(nativeContractDate), nativeContractMillis);
assert.equal(millisFromWorklogDate(nativeContractDate), nativeContractMillis);
assert.equal(worklogUpdateDatesConfirm(nativeContractMillis, nativeContractDate), true);
assert.equal(worklogUpdateDatesConfirm(1783920600000, 1783967400000), false);
assert.equal(worklogDatesSemanticallyMatch(1783920600000, 1783967400000), true);

const nativeDateOnlyUpdate = updateDto({
  id: "remote-worklog-native-date",
  docketId: "remote-docket-1",
  comment: "native date contract",
  worklogDate: nativeContractDate,
  hour: 2,
  min: 0,
});
assert.equal(nativeDateOnlyUpdate.worklogDate, nativeContractMillis);

const arbitraryDate = "2026-09-21";
const arbitraryDateMillis = millisFromWorklogDate(arbitraryDate);
assert.equal(Number.isFinite(arbitraryDateMillis), true);
assert.equal(worklogDatesSemanticallyMatch(arbitraryDateMillis, arbitraryDate), true);
assert.equal(arbitraryDateMillis, Date.UTC(2026, 8, 21));

const dateOnlyUpdate = outboundPayload({
  operation: "update",
  remoteId: "remote-worklog-date-only",
  payload: {},
  changes: { worklogDate: arbitraryDateMillis },
  remoteBaseline: baseline,
}, "remote-docket-1");
assert.equal(updateDto(dateOnlyUpdate).worklogDate, arbitraryDateMillis);

await queue.enqueueWorklogUpdate({
  worklog: {
    id: "remote-worklog-partial",
    docketId: "remote-docket-1",
    comment: "old partial",
    worklogDate: baseline.worklogDate,
    hour: 1,
    min: 0,
    sync: {
      status: "synced",
      remoteId: "remote-worklog-partial",
      remoteBaseline: {
        comment: "old partial",
        worklogDate: baseline.worklogDate,
        hour: 1,
        min: 0,
      },
    },
  },
  changes: {
    comment: "confirmed partial",
    worklogDate: arbitraryDateMillis,
    hour: 4,
    min: 45,
  },
});
loaded = await queue.load();
const partialOperation = loaded.operations.find((operation) =>
  operation.entityType === "worklog" &&
  operation.operation === "update" &&
  operation.localId === "remote-worklog-partial"
);
assert.equal(partialOperation.changes.comment, "confirmed partial");
assert.equal(partialOperation.changes.worklogDate, String(arbitraryDateMillis));
assert.equal(partialOperation.changes.hour, 4);
assert.equal(partialOperation.changes.min, 45);

await queue.markUpdateFieldsSynced(partialOperation.operationId, {
  localId: "remote-worklog-partial",
  remoteId: "remote-worklog-partial",
  acceptedChanges: {
    comment: "confirmed partial",
    hour: 4,
    min: 45,
  },
  remoteBaseline: {
    comment: "confirmed partial",
    worklogDate: baseline.worklogDate,
    hour: 4,
    min: 45,
  },
  error: new Error("Elitical Worklog update was not confirmed for: worklogDate."),
});
loaded = await queue.load();
const pendingPartial = loaded.operations.find((operation) =>
  operation.entityType === "worklog" &&
  operation.operation === "update" &&
  operation.localId === "remote-worklog-partial"
);
assert.equal(pendingPartial.status, "sync-failed");
assert.deepEqual(pendingPartial.changes, { worklogDate: String(arbitraryDateMillis) });
assert.deepEqual(pendingPartial.remoteBaseline, {
  comment: "confirmed partial",
  worklogDate: baseline.worklogDate,
  hour: 4,
  min: 45,
});
const retryDto = updateDto(outboundPayload(pendingPartial, "remote-docket-1"));
assert.equal(retryDto.comment, "confirmed partial");
assert.equal(retryDto.hour, 4);
assert.equal(retryDto.min, 45);
assert.equal(retryDto.worklogDate, arbitraryDateMillis);

console.log("Worklog update reconciliation verification PASS");
