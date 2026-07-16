import { useMemo, useState } from "react";

const VIEW_LABELS = {
  backlog: "Backlog View",
  worklog: "Worklog View",
};

function dateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function formatDate(value, options = {}) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unscheduled";
  return new Intl.DateTimeFormat("en", options).format(date);
}

function itemLoggedHours(item) {
  if (Number.isFinite(Number(item.loggedHours)) && Number(item.loggedHours) > 0) {
    return Number(item.loggedHours);
  }

  if (Number.isFinite(Number(item.timeMinutes))) {
    return Number(item.timeMinutes) / 60;
  }

  return 0;
}

function itemStoryPoints(item) {
  return Number(item.storyPoints || 0);
}

function allStats(items) {
  const totals = items.reduce(
    (acc, item) => ({
      estimated: acc.estimated + Number(item.estimatedHours || 0),
      logged: acc.logged + itemLoggedHours(item),
      remaining: acc.remaining + Number(item.remainingHours || 0),
      storyPoints: acc.storyPoints + itemStoryPoints(item),
      completed:
        acc.completed +
        (["artifact", "closed"].includes(item.docketState) ? 1 : 0),
    }),
    {
      estimated: 0,
      logged: 0,
      remaining: 0,
      storyPoints: 0,
      completed: 0,
    }
  );

  return {
    ...totals,
    completion:
      items.length > 0 ? Math.round((totals.completed / items.length) * 100) : 0,
  };
}

function optionValues(items, field) {
  return Array.from(
    new Set(
      items
        .flatMap((item) => {
          const value = item[field];
          return Array.isArray(value) ? value : [value];
        })
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b));
}

function PlanningCard({ item, onOpenDetails, actionLabel = "Open" }) {
  return (
    <button
      type="button"
      className="planning-card"
      onClick={() => onOpenDetails(item.id)}
    >
      <span>{item.title}</span>
      <small>
        {item.type} · {item.docketState}
        {item.storyPoints ? ` · ${item.storyPoints} SP` : ""}
        {itemLoggedHours(item) ? ` · ${itemLoggedHours(item).toFixed(1)}h logged` : ""}
      </small>
      <strong>{actionLabel}</strong>
    </button>
  );
}

function PlanningStats({ stats }) {
  return (
    <div className="planning-stats">
      <span>{stats.logged.toFixed(1)}h Logged</span>
      <span>{stats.remaining.toFixed(1)}h Remaining</span>
      <span>{stats.storyPoints} SP</span>
      <span>{stats.completion}% Complete</span>
    </div>
  );
}

export default function PlanningView({
  viewMode,
  workItems,
  sprints,
  onOpenDetails,
}) {
  const [filters, setFilters] = useState({
    sprint: "",
    epic: "",
    status: "",
    priority: "",
    type: "",
    label: "",
    assignee: "",
  });

  const filteredItems = useMemo(() => {
    return workItems.filter((item) => {
      if (filters.sprint && item.sprint !== filters.sprint) return false;
      if (filters.epic && item.parentId !== filters.epic) return false;
      if (filters.status && item.docketState !== filters.status) return false;
      if (filters.priority && item.priority !== filters.priority) return false;
      if (filters.type && item.type !== filters.type) return false;
      if (filters.assignee && item.assignee !== filters.assignee) return false;
      if (filters.label && !(item.labels || []).includes(filters.label)) return false;
      return true;
    });
  }, [filters, workItems]);

  const stats = useMemo(() => allStats(filteredItems), [filteredItems]);
  const epicOptions = useMemo(
    () => workItems.filter((item) => item.type === "epic"),
    [workItems]
  );

  function updateFilter(field, value) {
    setFilters((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function renderWorklog() {
    const jobs = filteredItems.filter((item) => item.type === "job");
    const entries = jobs.flatMap((item) =>
      (item.worklogs || []).map((entry) => ({
        item,
        entry,
        key: dateKey(entry.date),
      }))
    );
    const grouped = entries.reduce((acc, entry) => {
      if (!acc.has(entry.key)) acc.set(entry.key, []);
      acc.get(entry.key).push(entry);
      return acc;
    }, new Map());

    return (
      <div className="planning-worklog">
        <section>
          <header>
            <strong>Jobs</strong>
            <span>{jobs.length} ready to log</span>
          </header>
          {jobs.map((item) => (
            <PlanningCard
              key={item.id}
              item={item}
              onOpenDetails={onOpenDetails}
              actionLabel="Quick Log"
            />
          ))}
        </section>
        {Array.from(grouped.entries())
          .sort(([a], [b]) => b.localeCompare(a))
          .map(([key, dayEntries]) => {
            const total = dayEntries.reduce(
              (sum, entry) => sum + Number(entry.entry.timeMinutes || 0) / 60,
              0
            );

            return (
              <section key={key}>
                <header>
                  <strong>{formatDate(key, { day: "numeric", month: "long" })}</strong>
                  <span>Total {total.toFixed(1)}h</span>
                </header>
                {dayEntries.map(({ item, entry }) => (
                  <button
                    key={`${item.id}:${entry.date}`}
                    type="button"
                    onClick={() => onOpenDetails(item.id)}
                  >
                    <span>{item.title}</span>
                    <strong>{(Number(entry.timeMinutes || 0) / 60).toFixed(1)}h</strong>
                  </button>
                ))}
              </section>
            );
          })}
      </div>
    );
  }

  function renderBacklog() {
    return (
      <div className="planning-list">
        {filteredItems
          .filter((item) => !item.sprint)
          .map((item) => (
            <PlanningCard
              key={item.id}
              item={item}
              onOpenDetails={onOpenDetails}
            />
          ))}
      </div>
    );
  }

  return (
    <main className="planning-view">
      <header className="planning-header">
        <div>
          <span>{viewMode === "worklog" ? "Worklog" : "Backlog"}</span>
          <h1>{VIEW_LABELS[viewMode] || "Worklog View"}</h1>
        </div>
        <PlanningStats stats={stats} />
      </header>

      <section className="planning-filters">
        <select value={filters.sprint} onChange={(event) => updateFilter("sprint", event.target.value)}>
          <option value="">All sprints</option>
          {sprints.map((sprint) => (
            <option key={sprint.id} value={sprint.title}>{sprint.title}</option>
          ))}
        </select>
        <select value={filters.epic} onChange={(event) => updateFilter("epic", event.target.value)}>
          <option value="">All epics</option>
          {epicOptions.map((item) => (
            <option key={item.id} value={item.id}>{item.title}</option>
          ))}
        </select>
        <select value={filters.status} onChange={(event) => updateFilter("status", event.target.value)}>
          <option value="">All statuses</option>
          {optionValues(workItems, "docketState").map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
        <select value={filters.priority} onChange={(event) => updateFilter("priority", event.target.value)}>
          <option value="">All priorities</option>
          {optionValues(workItems, "priority").map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
        <select value={filters.type} onChange={(event) => updateFilter("type", event.target.value)}>
          <option value="">All types</option>
          {optionValues(workItems, "type").map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
        <select value={filters.label} onChange={(event) => updateFilter("label", event.target.value)}>
          <option value="">All labels</option>
          {optionValues(workItems, "labels").map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
        <select value={filters.assignee} onChange={(event) => updateFilter("assignee", event.target.value)}>
          <option value="">All assignees</option>
          {optionValues(workItems, "assignee").map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
      </section>

      <section className="planning-surface">
        {viewMode === "backlog" ? renderBacklog() : renderWorklog()}
      </section>
    </main>
  );
}
