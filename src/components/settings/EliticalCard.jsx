function valueOrDash(value) {
  return value || "-";
}

export default function EliticalCard({
  status,
  context,
  error,
  onConnect,
  onDisconnect,
  onSyncNow,
}) {
  const connected = status === "Connected" && context;
  const busy = status === "Connecting" || status === "Syncing";

  return (
    <section className="integration-card">
      <header>
        <div>
          <h3>Elitical</h3>
          <p>Official company work data.</p>
        </div>
        <span className={`integration-status ${status.toLowerCase().replaceAll(" ", "-")}`}>
          {status}
        </span>
      </header>

      {connected ? (
        <dl>
          <div>
            <dt>Employee</dt>
            <dd>{valueOrDash(context.employee.name)}</dd>
          </div>
          <div>
            <dt>Employee ID</dt>
            <dd>{valueOrDash(context.employee.id)}</dd>
          </div>
          <div>
            <dt>Project</dt>
            <dd>{valueOrDash(context.project.name)}</dd>
          </div>
          <div>
            <dt>Current sprint</dt>
            <dd>{valueOrDash(context.sprint.name)}</dd>
          </div>
          <div>
            <dt>Last sync</dt>
            <dd>{valueOrDash(context.lastSyncedAt)}</dd>
          </div>
        </dl>
      ) : (
        <p className="integration-empty">Not Connected</p>
      )}

      {error && <p className="integration-error">{error}</p>}

      <footer>
        {connected ? (
          <>
            <button type="button" className="secondary-button" onClick={onDisconnect}>
              Disconnect
            </button>
            <button type="button" onClick={onSyncNow} disabled={busy}>
              {status === "Syncing" ? "Syncing..." : "Sync Now"}
            </button>
          </>
        ) : (
          <button type="button" onClick={onConnect} disabled={busy}>
            {busy ? status : "Connect Elitical"}
          </button>
        )}
      </footer>
    </section>
  );
}
