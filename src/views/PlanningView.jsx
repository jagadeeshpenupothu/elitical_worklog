import { useMemo, useState } from "react";

const PLANNING_VIEW_LABELS = {
  backlog: "Backlog View",
  timeline: "Timeline View",
  calendar: "Calendar View",
  month: "Month View",
  week: "Week View",
  day: "Day View",
  range: "Custom Date Range",
  worklog: "Work Log View",
};

const WORK_START_HOUR = 8;
const WORK_END_HOUR = 21;
const DAY_MS = 24 * 60 * 60 * 1000;

function dateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}

function toDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfWeek(date) {
  const next = startOfDay(date);
  const day = next.getDay() || 7;
  next.setDate(next.getDate() - day + 1);
  return next;
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function formatDate(value, options = {}) {
  const date = toDate(value);
  if (!date) return "Unscheduled";
  return new Intl.DateTimeFormat("en", options).format(date);
}

function formatHour(hour) {
  return `${String(hour).padStart(2, "0")}:00`;
}

function itemScheduleDate(item) {
  return item.plannedStartDate || item.dueDate || item.actualStartDate || item.createdAt;
}

function itemEndDate(item) {
  return item.plannedEndDate || item.dueDate || item.actualEndDate || itemScheduleDate(item);
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

function itemMatchesDate(item, key) {
  return dateKey(itemScheduleDate(item)) === key ||
    dateKey(itemEndDate(item)) === key ||
    dateKey(item.dueDate) === key ||
    (Array.isArray(item.worklogs) &&
      item.worklogs.some((entry) => dateKey(entry.date) === key));
}

function itemWithinRange(item, start, end) {
  const itemStart = toDate(itemScheduleDate(item));
  const itemEnd = toDate(itemEndDate(item));

  if (!itemStart && !itemEnd) return false;

  const normalizedStart = startOfDay(start);
  const normalizedEnd = startOfDay(end);
  const scheduledStart = startOfDay(itemStart || itemEnd);
  const scheduledEnd = startOfDay(itemEnd || itemStart);

  return scheduledStart <= normalizedEnd && scheduledEnd >= normalizedStart;
}

function rangeDays(start, end) {
  const days = [];
  let cursor = startOfDay(start);
  const last = startOfDay(end);

  while (cursor <= last) {
    days.push(new Date(cursor));
    cursor = addDays(cursor, 1);
  }

  return days;
}

function monthDays(anchor) {
  const first = startOfWeek(startOfMonth(anchor));
  const last = addDays(startOfWeek(endOfMonth(anchor)), 6);
  return rangeDays(first, last);
}

function hoursForDay(items) {
  return items.reduce(
    (totals, item) => ({
      estimated: totals.estimated + Number(item.estimatedHours || 0),
      logged: totals.logged + itemLoggedHours(item),
      remaining: totals.remaining + Number(item.remainingHours || 0),
      storyPoints: totals.storyPoints + itemStoryPoints(item),
      completed: totals.completed + (item.docketState === "closed" ? 1 : 0),
    }),
    {
      estimated: 0,
      logged: 0,
      remaining: 0,
      storyPoints: 0,
      completed: 0,
    }
  );
}

function allStats(items) {
  const totals = hoursForDay(items);
  const completion = items.length > 0
    ? Math.round((totals.completed / items.length) * 100)
    : 0;

  return {
    ...totals,
    completion,
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

function PlanningCard({ item, onOpenDetails }) {
  return (
    <button
      type="button"
      className="planning-card"
      onClick={() => onOpenDetails(item.id)}
    >
      <span>{item.title}</span>
      <small>
        {item.type} · {item.docketState}
        {item.estimatedHours ? ` · ${item.estimatedHours}h est` : ""}
        {itemLoggedHours(item) ? ` · ${itemLoggedHours(item)}h logged` : ""}
      </small>
    </button>
  );
}

function PlanningStats({ stats }) {
  return (
    <div className="planning-stats">
      <span>{stats.estimated.toFixed(1)}h Estimated</span>
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
  anchorDate: controlledAnchorDate,
  onAnchorDateChange,
  onOpenDay,
}) {
  const today = useMemo(() => startOfDay(new Date()), []);
  const [localAnchorDate, setLocalAnchorDate] = useState(dateKey(today));
  const [rangeStart, setRangeStart] = useState(dateKey(addDays(today, -7)));
  const [rangeEnd, setRangeEnd] = useState(dateKey(addDays(today, 14)));
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

  const anchorDate = controlledAnchorDate || localAnchorDate;
  const anchor = toDate(anchorDate) || today;
  const activeMode = viewMode === "calendar" ? "month" : viewMode;
  const stats = useMemo(() => allStats(filteredItems), [filteredItems]);
  const epicOptions = useMemo(
    () => workItems.filter((item) => item.type === "epic"),
    [workItems]
  );

  const dateRange = useMemo(() => {
    if (activeMode === "month") return monthDays(anchor);
    if (activeMode === "week") return rangeDays(startOfWeek(anchor), addDays(startOfWeek(anchor), 6));
    if (activeMode === "day") return [anchor];
    if (activeMode === "range") {
      const start = toDate(rangeStart) || anchor;
      const end = toDate(rangeEnd) || start;
      return rangeDays(start <= end ? start : end, end >= start ? end : start);
    }

    return [];
  }, [activeMode, anchor, rangeEnd, rangeStart]);

  const rangedItems = useMemo(() => {
    if (!["month", "week", "day", "range"].includes(activeMode)) return filteredItems;
    if (dateRange.length === 0) return filteredItems;

    const start = dateRange[0];
    const end = dateRange[dateRange.length - 1];
    return filteredItems.filter((item) => itemWithinRange(item, start, end));
  }, [activeMode, dateRange, filteredItems]);

  function updateFilter(field, value) {
    setFilters((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function renderCalendarGrid(days) {
    return (
      <div className={`planning-calendar ${activeMode}`}>
        {days.map((day) => {
          const key = dateKey(day);
          const dayItems = rangedItems.filter((item) => itemMatchesDate(item, key));
          const dayStats = hoursForDay(dayItems);

          return (
            <section key={key} className="planning-day-cell">
              <header>
                <button
                  type="button"
                  className="planning-day-link"
                  onClick={() => onOpenDay?.(key)}
                >
                  {formatDate(day, { weekday: "short", day: "numeric" })}
                </button>
                <span>{dayStats.logged.toFixed(1)}h / {dayStats.estimated.toFixed(1)}h</span>
              </header>
              <small>
                {dayItems.filter((item) => item.type === "job").length} jobs ·{" "}
                {dayItems.filter((item) => item.type === "story").length} stories ·{" "}
                {dayStats.logged.toFixed(1)}h logged
              </small>
              <div className="planning-card-list">
                {dayItems.map((item) => (
                  <PlanningCard
                    key={item.id}
                    item={item}
                    onOpenDetails={onOpenDetails}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    );
  }

  function renderDayPlanner() {
    const key = dateKey(anchor);
    const dayItems = rangedItems.filter((item) => itemMatchesDate(item, key));

    return (
      <div className="planning-day-planner">
        {Array.from({ length: WORK_END_HOUR - WORK_START_HOUR + 1 }, (_, index) => {
          const hour = WORK_START_HOUR + index;

          return (
            <section key={hour} className="planning-hour-row">
              <time>{formatHour(hour)}</time>
              <div>
                {dayItems
                  .filter((_, itemIndex) => itemIndex % (WORK_END_HOUR - WORK_START_HOUR + 1) === index)
                  .map((item) => (
                    <PlanningCard
                      key={item.id}
                      item={item}
                      onOpenDetails={onOpenDetails}
                    />
                  ))}
              </div>
            </section>
          );
        })}
      </div>
    );
  }

  function renderTimeline() {
    const items = filteredItems.filter((item) =>
      ["epic", "story", "task", "job"].includes(item.type) &&
      (item.plannedStartDate || item.dueDate)
    );
    const dates = items.flatMap((item) => [itemScheduleDate(item), itemEndDate(item)])
      .map(toDate)
      .filter(Boolean);
    const start = dates.length ? new Date(Math.min(...dates.map((date) => date.getTime()))) : today;
    const end = dates.length ? new Date(Math.max(...dates.map((date) => date.getTime()))) : addDays(today, 14);
    const totalDays = Math.max(1, Math.round((startOfDay(end) - startOfDay(start)) / DAY_MS) + 1);

    return (
      <div className="planning-timeline">
        {items.map((item) => {
          const itemStart = toDate(itemScheduleDate(item)) || start;
          const itemEnd = toDate(itemEndDate(item)) || itemStart;
          const offset = Math.max(0, Math.round((startOfDay(itemStart) - startOfDay(start)) / DAY_MS));
          const span = Math.max(1, Math.round((startOfDay(itemEnd) - startOfDay(itemStart)) / DAY_MS) + 1);

          return (
            <button
              key={item.id}
              type="button"
              className="planning-timeline-row"
              onClick={() => onOpenDetails(item.id)}
            >
              <span>{item.title}</span>
              <div>
                <i
                  style={{
                    marginLeft: `${(offset / totalDays) * 100}%`,
                    width: `${Math.min(100, (span / totalDays) * 100)}%`,
                  }}
                />
              </div>
            </button>
          );
        })}
      </div>
    );
  }

  function renderWorklog() {
    const entries = filteredItems.flatMap((item) =>
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
            <PlanningCard key={item.id} item={item} onOpenDetails={onOpenDetails} />
          ))}
      </div>
    );
  }

  return (
    <main className="planning-view">
      <header className="planning-header">
        <div>
          <span>Planning</span>
          <h1>{PLANNING_VIEW_LABELS[viewMode] || "Planning View"}</h1>
        </div>
        <PlanningStats stats={stats} />
      </header>

      <section className="planning-filters">
        <input
          type="date"
          value={anchorDate}
          onChange={(event) => {
            setLocalAnchorDate(event.target.value);
            onAnchorDateChange?.(event.target.value);
          }}
          aria-label="Anchor date"
        />
        {activeMode === "range" && (
          <>
            <input
              type="date"
              value={rangeStart}
              onChange={(event) => setRangeStart(event.target.value)}
              aria-label="Range start"
            />
            <input
              type="date"
              value={rangeEnd}
              onChange={(event) => setRangeEnd(event.target.value)}
              aria-label="Range end"
            />
          </>
        )}
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
        {activeMode === "timeline" && renderTimeline()}
        {activeMode === "worklog" && renderWorklog()}
        {activeMode === "backlog" && renderBacklog()}
        {["month", "week", "range"].includes(activeMode) && renderCalendarGrid(dateRange)}
        {activeMode === "day" && renderDayPlanner()}
      </section>
    </main>
  );
}
