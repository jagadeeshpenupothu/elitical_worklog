function formatValue(value, fallback = "Not configured") {
  return value || fallback;
}

export default function GitHubCard({
  repository,
  lastSync,
  status,
  onSyncNow,
  syncing = false,
}) {
  return (
    <section className="integration-card">
      <header>
        <div>
          <h3>GitHub</h3>
          <p>Personal notes, layout, AI data, and preferences.</p>
        </div>
        <span className={`integration-status ${status.toLowerCase()}`}>
          {status}
        </span>
      </header>
      <dl>
        <div>
          <dt>Repository</dt>
          <dd>{formatValue(repository)}</dd>
        </div>
        <div>
          <dt>Last sync</dt>
          <dd>{formatValue(lastSync, "Never")}</dd>
        </div>
      </dl>
      <footer>
        <button type="button" onClick={onSyncNow} disabled={syncing}>
          {syncing ? "Syncing..." : "Sync Now"}
        </button>
      </footer>
    </section>
  );
}
