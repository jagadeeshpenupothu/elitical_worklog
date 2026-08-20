import assert from "node:assert/strict";
import {
  GITHUB_CONTENTS_API_SAFE_BODY_BYTES,
  contentsApiRequestBodyBytes,
  githubPublicationTransportForFiles,
  publicationFilesForSnapshot,
  publishCacheFiles,
} from "../local-backend/services/GitHubDataService.mjs";

const config = {
  token: "redacted-test-token",
  owner: "fixture-owner",
  repo: "fixture-repo",
  branch: "main",
  cacheDir: "data",
  path: "data/worklog.json",
};
const syncGenerationId = "elitical-sync-123-fixture";
const snapshot = {
  snapshotId: syncGenerationId,
  syncGenerationId,
  syncGenerationSequence: 123,
  syncedAt: "2026-08-09T00:00:00.000Z",
};
const publicationConfig = {
  ok: true,
  missing: [],
  config,
};

function payloadOfBytes(bytes, label = "graph") {
  return {
    snapshotId: syncGenerationId,
    syncGenerationId,
    syncGenerationSequence: snapshot.syncGenerationSequence,
    snapshot,
    appState: {
      workItems: [
        {
          id: `${label}-${bytes}`,
          title: "Generated publication transport fixture",
          type: "story",
          description: "x".repeat(bytes),
        },
      ],
      sprints: [],
    },
  };
}

function worklogsPayload(bytes = 128) {
  return {
    snapshotId: syncGenerationId,
    syncGenerationId,
    syncGenerationSequence: snapshot.syncGenerationSequence,
    snapshot,
    worklogs: [
      {
        id: "worklog-fixture",
        description: "w".repeat(bytes),
      },
    ],
  };
}

function metadataPayload() {
  return {
    snapshotId: syncGenerationId,
    syncGenerationId,
    syncGenerationSequence: snapshot.syncGenerationSequence,
    snapshot,
    lastSuccessfulSync: snapshot.syncedAt,
  };
}

function snapshotBundle({ graphBytes, worklogBytes = 128 } = {}) {
  return {
    graph: payloadOfBytes(graphBytes),
    worklogs: worklogsPayload(worklogBytes),
    metadata: metadataPayload(),
    message: "test: verify publication transport",
  };
}

async function publishWithMocks(bundle) {
  const calls = {
    contents: [],
    git: [],
  };
  const result = await publishCacheFiles(bundle, {
    publicationConfig,
    contentsPublisher: async (publisherConfig, filePath, payload, options) => {
      calls.contents.push({ publisherConfig, filePath, payload, options });

      return {
        path: filePath,
        sha: `contents-sha-${filePath}`,
        commitSha: `contents-commit-${filePath}`,
      };
    },
    gitPublisher: async ({ files, descriptor, sequence, transportDecision }) => {
      calls.git.push({ files, descriptor, sequence, transportDecision });

      return {
        status: "published",
        transport: "git",
        changed: true,
        snapshotId: syncGenerationId,
        syncGenerationId,
        syncGenerationSequence: sequence,
        commitSha: "git-commit-sha",
        files: files.map((file) => ({
          path: file.filePath,
          sha: `git-sha-${file.filePath}`,
          commitSha: "git-commit-sha",
        })),
      };
    },
  });

  return {
    calls,
    result,
  };
}

function transportForGraphBytes(graphBytes) {
  const bundle = snapshotBundle({ graphBytes });
  const files = publicationFilesForSnapshot({ ...bundle, config });
  const decision = githubPublicationTransportForFiles({
    files,
    message: bundle.message,
    branch: config.branch,
  });
  const graphFile = files.find((file) => file.fileName === "graph.json");

  return {
    decision,
    graphBodyBytes: contentsApiRequestBodyBytes({
      message: bundle.message,
      content: graphFile.content,
      branch: config.branch,
      sha: "0000000000000000000000000000000000000000",
    }),
  };
}

assert.equal(
  GITHUB_CONTENTS_API_SAFE_BODY_BYTES,
  8_000_000,
  "safe Contents API threshold stays intentionally conservative"
);

const expectedTransports = [
  [1, "contents-api"],
  [5, "contents-api"],
  [8, "git"],
  [10, "git"],
  [15, "git"],
  [20, "git"],
];

for (const [megabytes, expectedTransport] of expectedTransports) {
  const { decision, graphBodyBytes } = transportForGraphBytes(megabytes * 1024 * 1024);

  assert.equal(
    decision.transport,
    expectedTransport,
    `${megabytes} MB generated graph routes to ${expectedTransport}; encoded body ${graphBodyBytes} bytes`
  );
}

{
  const { calls, result } = await publishWithMocks(snapshotBundle({ graphBytes: 1 * 1024 * 1024 }));

  assert.equal(result.transport, "contents-api", "small batch publishes through Contents API");
  assert.equal(calls.contents.length, 3, "small batch writes all three files through Contents API");
  assert.equal(calls.git.length, 0, "small batch does not call git publisher");
}

{
  const { calls, result } = await publishWithMocks(snapshotBundle({ graphBytes: 10 * 1024 * 1024 }));

  assert.equal(result.transport, "git", "large batch publishes through git transport");
  assert.equal(calls.contents.length, 0, "large batch never calls Contents API");
  assert.equal(calls.git.length, 1, "large batch calls git publisher once");
  assert.deepEqual(
    calls.git[0].files.map((file) => file.filePath),
    ["data/graph.json", "data/worklogs.json", "data/metadata.json"],
    "large batch commits all published files together"
  );
  assert.equal(
    calls.git[0].files.every((file) => file.payload.syncGenerationId === syncGenerationId),
    true,
    "all files in git batch have the same generation"
  );
}

{
  const { calls, result } = await publishWithMocks(
    snapshotBundle({
      graphBytes: 256,
      worklogBytes: 10 * 1024 * 1024,
    })
  );

  assert.equal(result.transport, "git", "large non-graph file also routes the whole batch to git");
  assert.equal(calls.contents.length, 0, "mixed-size batch avoids partial Contents API publication");
  assert.equal(calls.git.length, 1, "mixed-size batch is committed as one git operation");
}

{
  const createLike = githubPublicationTransportForFiles({
    files: [
      {
        filePath: "data/new-file.json",
        content: JSON.stringify(payloadOfBytes(10 * 1024 * 1024)),
      },
    ],
    message: "test: create large file",
    branch: config.branch,
    assumeUpdateSha: "",
  });
  const updateLike = githubPublicationTransportForFiles({
    files: [
      {
        filePath: "data/existing-file.json",
        content: JSON.stringify(payloadOfBytes(10 * 1024 * 1024)),
      },
    ],
    message: "test: update large file",
    branch: config.branch,
  });

  assert.equal(createLike.transport, "git", "large new file creation routes to git");
  assert.equal(updateLike.transport, "git", "large existing file update routes to git");
}

console.log("GitHub publication transport verification PASS");
