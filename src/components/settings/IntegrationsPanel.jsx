import EliticalCard from "./EliticalCard";
import GitHubCard from "./GitHubCard";

export default function IntegrationsPanel({
  github,
  elitical,
}) {
  return (
    <section className="settings-section">
      <h2>Integrations</h2>
      <div className="integrations-grid">
        <GitHubCard {...github} />
        <EliticalCard {...elitical} />
      </div>
    </section>
  );
}
