import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildProjectedHierarchy,
  isReferenceNode,
} from "../utils/hierarchyProjection";
import { calculateStoryPoints } from "../utils/worklogModel";
import { formatWorkDuration } from "../utils/durationFormat";
import {
  CANONICAL_DOCKET_STATES,
  docketStateLabel,
  normalizeDocketState,
} from "../utils/docketStates";
import { docketNumberForItem } from "../utils/docketIdentity";

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

function itemLoggedMinutes(item) {
  if (Number.isFinite(Number(item.loggedHours)) && Number(item.loggedHours) > 0) {
    return Math.round(Number(item.loggedHours) * 60);
  }

  if (Number.isFinite(Number(item.timeMinutes))) {
    return Math.max(0, Math.round(Number(item.timeMinutes)));
  }

  return 0;
}

function itemStoryPoints(item) {
  return Number(item.storyPoints || 0);
}

function worklogMatchesEmployeeScope(entry, employeeScope) {
  const employeeId = String(employeeScope?.employeeId || employeeScope?.id || "").trim();

  if (!employeeId) return true;

  return String(entry?.employeeId || "").trim() === employeeId;
}

function allStats(items, aggregateTotals) {
  const totals = items.reduce(
    (acc, item) => ({
      estimated: acc.estimated + Number(item.estimatedHours || 0),
      remaining: acc.remaining + Number(item.remainingHours || 0),
      completed:
        acc.completed +
        (["artifact", "closed"].includes(normalizeDocketState(item.docketState)) ? 1 : 0),
    }),
    {
      estimated: 0,
      remaining: 0,
      completed: 0,
    }
  );

  return {
    ...totals,
    loggedMinutes: Number(aggregateTotals.rootTimeMinutes || 0),
    storyPoints: aggregateTotals.rootTotal || 0,
    completion:
      items.length > 0 ? Math.round((totals.completed / items.length) * 100) : 0,
  };
}

function optionValues(items, field) {
  if (field === "docketState") return CANONICAL_DOCKET_STATES;

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

function PlanningCard({
  item,
  onOpenDetails,
  actionLabel = "Open",
  searchMatch = false,
  searchActive = false,
  nodeRef,
  aggregateTotals,
}) {
  const isReference = isReferenceNode(item);
  const storyPoints =
    aggregateTotals?.byId?.[item.id] ?? itemStoryPoints(item);
  const loggedMinutes =
    aggregateTotals?.timeById?.[item.id] !== undefined
      ? Number(aggregateTotals.timeById[item.id] || 0)
      : itemLoggedMinutes(item);
  const docketNumber = docketNumberForItem(item);

  return (
    <button
      ref={nodeRef}
      type="button"
      className={`planning-card ${isReference ? "planning-card-reference" : ""} ${
        searchMatch ? "search-match" : ""
      } ${searchActive ? "search-active" : ""}`}
      onClick={() => {
        if (!isReference) onOpenDetails(item.id);
      }}
      disabled={isReference}
    >
      {docketNumber && (
        <em className="planning-card-docket-number">
          {docketNumber} {docketStateLabel(item.docketState)}
        </em>
      )}
      <span>{item.title}</span>
      <small>
        {isReference ? "Reference " : ""}{item.type} · {docketStateLabel(item.docketState)}
        {storyPoints ? ` · ${storyPoints} SP` : ""}
        {loggedMinutes ? ` · ${formatWorkDuration(loggedMinutes)} logged` : ""}
      </small>
      <strong>{isReference ? "Reference" : actionLabel}</strong>
    </button>
  );
}

function PlanningStats({ stats }) {
  return (
    <div className="planning-stats">
      <span>{formatWorkDuration(stats.loggedMinutes)} Logged</span>
      <span>{stats.remaining.toFixed(1)}h Remaining</span>
      <span>{stats.storyPoints} SP</span>
      <span>{stats.completion}% Complete</span>
    </div>
  );
}

export default function PlanningView({
  viewMode,
  workItems,
  allWorkItems = workItems,
  sprints,
  onOpenDetails,
  searchMatchIds = new Set(),
  activeSearchId = "",
  employeeScope = null,
}) {
  const searchNodeRefs = useRef(new Map());
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
      if (filters.status && normalizeDocketState(item.docketState) !== filters.status) return false;
      if (filters.priority && item.priority !== filters.priority) return false;
      if (filters.type && item.type !== filters.type) return false;
      if (filters.assignee && item.assignee !== filters.assignee) return false;
      if (filters.label && !(item.labels || []).includes(filters.label)) return false;
      return true;
    });
  }, [filters, workItems]);
  const hasActiveFilter = Object.values(filters).some(Boolean);
  const projectedItems = useMemo(
    () =>
      buildProjectedHierarchy({
        items: filteredItems,
        allItems: allWorkItems,
        scopes: sprints,
        enabled: hasActiveFilter,
      }).items,
    [allWorkItems, filteredItems, hasActiveFilter, sprints]
  );
  const aggregateTotals = useMemo(
    () => calculateStoryPoints(projectedItems, { sprints, employeeScope }),
    [employeeScope, projectedItems, sprints]
  );

  const stats = useMemo(
    () => allStats(filteredItems, aggregateTotals),
    [aggregateTotals, filteredItems]
  );
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

  useEffect(() => {
    if (!activeSearchId) return;

    searchNodeRefs.current.get(activeSearchId)?.scrollIntoView({
      block: "center",
      behavior: "smooth",
    });
  }, [activeSearchId]);

  function searchRefFor(id) {
    return (node) => {
      if (node) {
        searchNodeRefs.current.set(id, node);
      } else {
        searchNodeRefs.current.delete(id);
      }
    };
  }

  function renderWorklog() {
    const jobs = projectedItems.filter((item) => item.type === "job");
    const entries = jobs.flatMap((item) =>
      (item.worklogs || [])
        .filter((entry) => worklogMatchesEmployeeScope(entry, employeeScope))
        .map((entry) => ({
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
              searchMatch={searchMatchIds.has(item.id)}
              searchActive={activeSearchId === item.id}
              nodeRef={searchRefFor(item.id)}
              aggregateTotals={aggregateTotals}
            />
          ))}
        </section>
        {Array.from(grouped.entries())
          .sort(([a], [b]) => b.localeCompare(a))
          .map(([key, dayEntries]) => {
            const totalMinutes = dayEntries.reduce(
              (sum, entry) => sum + Number(entry.entry.timeMinutes || 0),
              0
            );

            return (
              <section key={key}>
                <header>
                  <strong>{formatDate(key, { day: "numeric", month: "long" })}</strong>
                  <span>Total {formatWorkDuration(totalMinutes)}</span>
                </header>
                {dayEntries.map(({ item, entry }) => (
                  <button
                    ref={searchRefFor(item.id)}
                    key={`${item.id}:${entry.date}`}
                    type="button"
                    onClick={() => onOpenDetails(item.id)}
                    className={`${searchMatchIds.has(item.id) ? "search-match" : ""} ${
                      activeSearchId === item.id ? "search-active" : ""
                    }`}
                  >
                    <span>{item.title}</span>
                    <strong>{formatWorkDuration(entry.timeMinutes)}</strong>
                  </button>
                ))}
              </section>
            );
          })}
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
            <option key={value} value={value}>{docketStateLabel(value)}</option>
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
        {renderWorklog()}
      </section>
    </main>
  );
}
