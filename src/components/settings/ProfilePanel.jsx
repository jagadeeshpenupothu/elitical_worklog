import IntegrationsPanel from "./IntegrationsPanel";

export default function ProfilePanel({
  open,
  onClose,
  github,
  elitical,
}) {
  if (!open) return null;

  return (
    <div className="settings-backdrop" onMouseDown={onClose}>
      <section
        className="settings-panel"
        onMouseDown={(event) => event.stopPropagation()}
        aria-label="Profile and settings"
      >
        <header className="settings-header">
          <div>
            <span>Profile</span>
            <h1>Settings</h1>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close settings"
          >
            ×
          </button>
        </header>

        <IntegrationsPanel github={github} elitical={elitical} />
      </section>
    </div>
  );
}
