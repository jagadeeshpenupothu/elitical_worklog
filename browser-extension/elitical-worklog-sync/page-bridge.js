(function installEliticalInterceptor() {
  const REQUEST_EVENT = "elitical-worklog-sync:request";
  const RESPONSE_EVENT = "elitical-worklog-sync:response";
  const READY_EVENT = "elitical-worklog-sync:ready";
  const READY_ATTR = "data-elitical-worklog-interceptor";
  const SOURCE = "elitical-worklog-extension";
  const SCHEMA_VERSION = 1;
  const MAX_RECORDS = 300;
  const SECRET_KEY = /(token|jwt|cookie|authorization|password|secret|jsessionid|sessionid)/i;

  if (window.__eliticalWorklogInterceptorInstalled) {
    console.debug("[Injected] Interceptor already installed.");
    eventTarget().setAttribute?.(READY_ATTR, "ready");
    eventTarget().dispatchEvent(new CustomEvent(READY_EVENT));
    return;
  }

  window.__eliticalWorklogInterceptorInstalled = true;

  const state = {
    installedAt: new Date().toISOString(),
    fetchPatched: false,
    xhrPatched: false,
    records: [],
  };

  window.__eliticalWorklogCapture = state;

  function eventTarget() {
    return document.documentElement || document;
  }

  function safeUrl(value) {
    try {
      const url = new URL(value, window.location.origin);
      return `${url.origin}${url.pathname}${url.search}`;
    } catch {
      return String(value || "");
    }
  }

  function shouldCapture(url) {
    return safeUrl(url).includes("/api/1/");
  }

  function endpointName(url) {
    try {
      const parsed = new URL(url, window.location.origin);
      return parsed.pathname.replace(/^\/api\/1\//, "");
    } catch {
      return String(url || "");
    }
  }

  function queryValue(record, keys) {
    try {
      const parsed = new URL(record.url, window.location.origin);
      const values = keys.map((key) => parsed.searchParams.get(key));

      return firstString(...values);
    } catch {
      return "";
    }
  }

  function queryValueFromRecords(keys, fragments = []) {
    const records = [...state.records].reverse();

    for (const record of records) {
      const haystack = `${record.endpoint} ${record.url}`.toLowerCase();
      const matchesFragment =
        fragments.length === 0 ||
        fragments.some((fragment) => haystack.includes(fragment.toLowerCase()));

      if (!matchesFragment) continue;

      const value = queryValue(record, keys);

      if (value) return value;
    }

    return "";
  }

  function readIdentityHints() {
    const visibleText = Array.from(
      document.querySelectorAll("header, [class*='profile'], [class*='account'], [class*='user']")
    )
      .map((node) => node.textContent || "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const visibleName =
      visibleText
        .split(/(?=My Account|Policies|Docket|Group|Company|Zone|Branch)/)
        .map((part) => part.trim())
        .find((part) => /^[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){1,3}$/.test(part)) ||
      "";

    return {
      id: firstString(
        localStorage.getItem("employeeId"),
        localStorage.getItem("empId")
      ),
      name: firstString(
        localStorage.getItem("userNameSession"),
        localStorage.getItem("userName"),
        localStorage.getItem("displayName"),
        visibleName
      ),
      email: firstString(localStorage.getItem("emailId"), localStorage.getItem("email")),
    };
  }

  function sanitize(value, depth = 0) {
    if (depth > 12) return null;
    if (Array.isArray(value)) return value.map((entry) => sanitize(entry, depth + 1));
    if (!value || typeof value !== "object") return value;

    return Object.entries(value).reduce((acc, [key, entry]) => {
      if (SECRET_KEY.test(key)) return acc;
      acc[key] = sanitize(entry, depth + 1);
      return acc;
    }, {});
  }

  function parseJson(value) {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value === "object") return value;

    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function listPayload(payload, key) {
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload?.[key])) return payload[key];
    if (Array.isArray(payload?.items)) return payload.items;
    if (Array.isArray(payload?.docketList)) return payload.docketList;
    if (payload?.docketListMap && typeof payload.docketListMap === "object") {
      return Object.values(payload.docketListMap).flatMap((value) =>
        Array.isArray(value) ? value : []
      );
    }

    return [];
  }

  function remember(record) {
    const cleanRecord = {
      id: crypto.randomUUID(),
      capturedAt: new Date().toISOString(),
      url: safeUrl(record.url),
      endpoint: endpointName(record.url),
      method: String(record.method || "GET").toUpperCase(),
      status: Number(record.status || 0),
      response: sanitize(record.response),
      transport: record.transport,
    };

    state.records.push(cleanRecord);

    if (state.records.length > MAX_RECORDS) {
      state.records.splice(0, state.records.length - MAX_RECORDS);
    }

    console.debug("[Injected] Captured Elitical API response", {
      endpoint: cleanRecord.endpoint,
      method: cleanRecord.method,
      status: cleanRecord.status,
      records: state.records.length,
    });
  }

  async function activeRequest(endpoint, query = {}) {
    const url = new URL(endpoint, window.location.origin);

    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, value);
      }
    });

    const response = await window.fetch(url.toString(), {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json",
      },
    });
    const payload = await response.clone().json().catch(() => null);

    if (payload) {
      remember({
        url: url.toString(),
        method: "GET",
        status: response.status,
        response: payload,
        transport: "active-fetch",
      });
    }

    if (!response.ok) {
      throw new Error(`Elitical ${endpoint} failed (${response.status}).`);
    }

    return payload;
  }

  async function activePullEliticalData() {
    const session = await activeRequest("/api/1/UserSessionDto");
    const employeeId = firstString(session?.employeeId, session?.empId, session?.id);

    if (employeeId) {
      await activeRequest("/api/1/Employee", { id: employeeId }).catch((error) => {
        console.debug("[Injected] Employee active pull skipped", error.message);
      });
    }

    const projectsPayload = await activeRequest("/api/1/Project/user");
    const project = listPayload(projectsPayload, "projects")[0] || null;
    const projectId = firstString(project?.id, project?.projectId, project?.cx);

    if (!projectId) return;

    const sprintsPayload = await activeRequest("/api/1/Sprint/activeList/projectId", {
      projectId,
    }).catch((error) => {
      console.debug("[Injected] Sprint active pull skipped", error.message);
      return null;
    });
    const sprint = listPayload(sprintsPayload, "sprintList")[0] || null;
    const sprintId = firstString(sprint?.id, sprint?.sprintId, sprint?.cx);

    await activeRequest("/api/1/SprintBoard", {
      projectId,
      sprintId,
    }).catch((error) => {
      console.debug("[Injected] SprintBoard active pull skipped", error.message);
    });

    if (employeeId) {
      await activeRequest("/api/1/Worklog/employee", {
        employeeId,
        projectId,
        worklogDate: new Date().toISOString().slice(0, 10),
      }).catch((error) => {
        console.debug("[Injected] Worklog active pull skipped", error.message);
      });
    }
  }

  function patchFetch() {
    if (typeof window.fetch !== "function" || window.fetch.__eliticalPatched) {
      state.fetchPatched = Boolean(window.fetch?.__eliticalPatched);
      return;
    }

    const originalFetch = window.fetch;

    window.fetch = async function patchedFetch(input, init) {
      const request = input instanceof Request ? input : null;
      const url = request?.url || input;
      const method = init?.method || request?.method || "GET";
      const response = await originalFetch.apply(this, arguments);

      if (shouldCapture(url)) {
        response
          .clone()
          .json()
          .then((payload) => {
            remember({
              url,
              method,
              status: response.status,
              response: payload,
              transport: "fetch",
            });
          })
          .catch(() => {
            console.debug("[Injected] Fetch response was not JSON", {
              url: safeUrl(url),
            });
          });
      }

      return response;
    };

    window.fetch.__eliticalPatched = true;
    state.fetchPatched = true;
  }

  function patchXhr() {
    if (
      typeof window.XMLHttpRequest !== "function" ||
      window.XMLHttpRequest.prototype.open.__eliticalPatched
    ) {
      state.xhrPatched = Boolean(
        window.XMLHttpRequest?.prototype?.open?.__eliticalPatched
      );
      return;
    }

    const originalOpen = window.XMLHttpRequest.prototype.open;
    const originalSend = window.XMLHttpRequest.prototype.send;

    window.XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
      this.__eliticalRequest = {
        method: method || "GET",
        url,
      };

      return originalOpen.apply(this, arguments);
    };

    window.XMLHttpRequest.prototype.send = function patchedSend() {
      this.addEventListener("loadend", () => {
        const request = this.__eliticalRequest;

        if (!request?.url || !shouldCapture(request.url)) return;

        const payload =
          this.responseType && this.responseType !== "text"
            ? parseJson(this.response)
            : parseJson(this.responseText);

        if (!payload) {
          console.debug("[Injected] XHR response was not JSON", {
            url: safeUrl(request.url),
          });
          return;
        }

        remember({
          url: request.url,
          method: request.method,
          status: this.status,
          response: payload,
          transport: "xhr",
        });
      });

      return originalSend.apply(this, arguments);
    };

    window.XMLHttpRequest.prototype.open.__eliticalPatched = true;
    state.xhrPatched = true;
  }

  function walkObjects(value, visitor, seen = new WeakSet()) {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    if (!Array.isArray(value)) visitor(value);

    Object.values(value).forEach((entry) => {
      if (entry && typeof entry === "object") walkObjects(entry, visitor, seen);
    });
  }

  function objectsFrom(records) {
    const objects = [];

    records.forEach((record) => {
      walkObjects(record.response, (object) => objects.push(object));
    });

    return objects;
  }

  function firstString(...values) {
    const value = values.find(
      (entry) => entry !== undefined && entry !== null && String(entry) !== ""
    );

    return value === undefined || value === null ? "" : String(value);
  }

  function firstNumber(...values) {
    const value = values.find((entry) => Number.isFinite(Number(entry)));

    return value === undefined || value === null ? 0 : Number(value);
  }

  function normalizeName(value) {
    return firstString(
      value?.name,
      value?.displayName,
      value?.fullName,
      value?.employeeName,
      value?.empName,
      value?.userName,
      value?.userNameSession
    );
  }

  function endpointRecords(fragment) {
    const needle = fragment.toLowerCase();

    return state.records.filter((record) =>
      `${record.endpoint} ${record.url}`.toLowerCase().includes(needle)
    );
  }

  function latestRecord(fragment) {
    return endpointRecords(fragment).at(-1) || null;
  }

  function likelyEmployee(object) {
    return Boolean(
      object?.employeeId ||
        object?.empId ||
        object?.userNameSession ||
        object?.employeeName ||
        object?.empName
    );
  }

  function normalizeEmployee() {
    const sessionObject = objectsFrom(endpointRecords("UserSessionDto")).find(
      likelyEmployee
    );
    const employeeObject =
      objectsFrom(endpointRecords("Employee")).find(likelyEmployee) ||
      sessionObject;
    const identityHints = readIdentityHints();
    const queryEmployeeId = queryValueFromRecords(
      ["employeeId", "empId", "id"],
      ["Worklog/employee", "Docket/emp", "Employee"]
    );

    if (!employeeObject && !sessionObject && !identityHints.id && !queryEmployeeId) {
      return null;
    }

    return {
      id: firstString(
        employeeObject?.id,
        employeeObject?.employeeId,
        employeeObject?.empId,
        sessionObject?.employeeId,
        sessionObject?.empId,
        queryEmployeeId,
        identityHints.id
      ),
      employeeId: firstString(
        employeeObject?.employeeId,
        sessionObject?.employeeId,
        queryEmployeeId,
        identityHints.id
      ),
      name:
        normalizeName(employeeObject) ||
        normalizeName(sessionObject) ||
        identityHints.name,
      email: firstString(
        employeeObject?.email,
        employeeObject?.emailId,
        sessionObject?.emailId,
        identityHints.email
      ),
    };
  }

  function normalizeProject() {
    const object = objectsFrom(endpointRecords("Project/user")).find(
      (entry) => entry?.projectId || entry?.projectName || entry?.name || entry?.id
    );

    const queryProjectId = queryValueFromRecords(
      ["projectId"],
      ["Project", "Sprint", "Worklog", "Docket", "Board"]
    );

    if (!object && !queryProjectId) return null;

    return {
      id: firstString(object?.id, object?.projectId, object?.cx, queryProjectId),
      name: firstString(object?.name, object?.projectName, object?.title, object?.db),
    };
  }

  function normalizeSprint() {
    const object = objectsFrom(endpointRecords("Sprint")).find(
      (entry) => entry?.sprintId || entry?.sprintName || entry?.name || entry?.id
    );

    const querySprintId = queryValueFromRecords(
      ["sprintId"],
      ["SprintBoard", "Docket/sprint", "Sprint"]
    );

    if (!object && !querySprintId) return null;

    return {
      id: firstString(object?.id, object?.sprintId, object?.cx, querySprintId),
      name: firstString(object?.name, object?.sprintName, object?.title, object?.db),
      startDate: firstString(object?.startDate, object?.sprintStartDate),
      endDate: firstString(object?.endDate, object?.sprintEndDate),
    };
  }

  function typeValue(...values) {
    const value = values.find((entry) => entry !== undefined && entry !== null && String(entry) !== "");

    if (!value || typeof value !== "object") return firstString(value);

    return firstString(
      value.name,
      value.type,
      value.code,
      value.value,
      value.label,
      value.displayName,
      value.title
    );
  }

  function itemType(item) {
    const normalized = typeValue(
      item?.type,
      item?.docketType,
      item?.dktType,
      item?.docketTypeName,
      item?.dktTypeName,
      item?.issueType,
      item?.workItemType
    )
      .toLowerCase()
      .replace(/^dockettype\./, "")
      .replace(/[^a-z0-9]+/g, "");

    if (normalized.includes("epic")) return "epic";
    if (normalized.includes("story")) return "story";
    if (
      normalized.includes("job") ||
      normalized.includes("task") ||
      normalized.includes("ticket") ||
      normalized.includes("bug") ||
      normalized.includes("work")
    ) {
      return "job";
    }

    return normalized;
  }

  function employeeMatches(value, employee) {
    const needles = [employee?.id, employee?.employeeId, employee?.name, employee?.email]
      .filter(Boolean)
      .map((entry) => String(entry).toLowerCase());

    if (needles.length === 0) return false;
    if (Array.isArray(value)) return value.some((entry) => employeeMatches(entry, employee));
    if (value && typeof value === "object") {
      return Object.values(value).some((entry) => employeeMatches(entry, employee));
    }
    if (value === undefined || value === null) return false;

    return needles.includes(String(value).toLowerCase());
  }

  function belongsToEmployee(item, employee) {
    return [
      item?.assignee,
      item?.assigneeId,
      item?.assigneeName,
      item?.assignedTo,
      item?.assignedEmployee,
      item?.employee,
      item?.employeeId,
      item?.empId,
      item?.owner,
      item?.reviewer,
      item?.reporter,
    ].some((value) => employeeMatches(value, employee));
  }

  function isVisibleDocketRecord(record) {
    return /sprintboard|docket/i.test(record.endpoint || "");
  }

  function normalizeDocket(item) {
    return {
      id: firstString(item?.id, item?.docketId, item?.dktId, item?.cx),
      type: itemType(item) || "task",
      title: firstString(item?.title, item?.name, item?.docketTitle),
      description: firstString(item?.description, item?.descr),
      status: firstString(item?.status, item?.docketState, item?.dktState),
      priority: firstString(item?.priority),
      category: firstString(item?.category),
      sprintId: firstString(item?.sprintId, item?.sprint?.id, item?.sprint?.cx),
      sprintName: firstString(item?.sprintName, item?.sprint?.name),
      parentId: firstString(item?.parentId, item?.parentDocketId),
      storyPoints: firstNumber(item?.storyPoints, item?.estimatedStoryPoints),
      updatedAt: firstString(item?.updatedAt, item?.updatedTime),
    };
  }

  function normalizeWorklog(item) {
    return {
      id: firstString(item?.id, item?.worklogId, item?.cx),
      docketId: firstString(item?.docketId, item?.docket?.id),
      employeeId: firstString(item?.employeeId, item?.empId, item?.employee?.id),
      projectId: firstString(item?.projectId, item?.project?.id),
      date: firstString(item?.worklogDate, item?.date, item?.createdDate),
      minutes: firstNumber(item?.minutes, item?.loggedMinutes),
      hours: firstNumber(item?.hours, item?.loggedHours, item?.duration),
      comment: firstString(item?.comment, item?.note, item?.description),
    };
  }

  function looksLikeWorklogSummary(item) {
    if (!item || typeof item !== "object") return false;

    const keys = Object.keys(item).join(" ").toLowerCase();

    return (
      /worklog|logged|hours|duration|minutes|time|date|docket|task|story/.test(keys) &&
      !/token|password|authorization|cookie/.test(keys)
    );
  }

  function normalizeWorklogSummary(item, index) {
    const date = firstString(
      item?.worklogDate,
      item?.date,
      item?.day,
      item?.createdDate,
      item?.logDate
    );
    const title = firstString(
      item?.title,
      item?.name,
      item?.docketTitle,
      item?.docketName,
      item?.taskName,
      item?.storyName
    );

    return {
      id: firstString(item?.id, item?.worklogId, item?.cx, `${date || "summary"}-${title || index}`),
      docketId: firstString(item?.docketId, item?.docket?.id),
      employeeId: firstString(item?.employeeId, item?.empId, item?.employee?.id),
      projectId: firstString(item?.projectId, item?.project?.id),
      date,
      minutes: firstNumber(item?.minutes, item?.loggedMinutes, item?.totalMinutes),
      hours: firstNumber(
        item?.hours,
        item?.loggedHours,
        item?.totalHours,
        item?.duration
      ),
      comment: firstString(item?.comment, item?.note, item?.description, title),
      summary: true,
    };
  }

  function numericTotal(value, patterns) {
    let total = 0;

    walkObjects(value, (object) => {
      Object.entries(object).forEach(([key, entry]) => {
        if (!patterns.some((pattern) => pattern.test(key))) return;

        const number = Number(entry);

        if (Number.isFinite(number)) total += number;
      });
    });

    return total;
  }

  function worklogRecordSummary(record, index) {
    const hours = numericTotal(record.response, [/hour/i, /duration/i]);
    const minutes = numericTotal(record.response, [/minute/i]);

    return {
      id: `endpoint-${record.endpoint}-${index}`,
      date: new Date(record.capturedAt).toISOString().slice(0, 10),
      hours,
      minutes,
      comment: record.endpoint,
      summary: true,
      endpointSummary: true,
    };
  }

  function uniqueById(items) {
    const seen = new Set();

    return items.filter((item) => {
      const id = firstString(item.id, item.title, item.date);
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  async function buildSnapshot() {
    await activePullEliticalData().catch((error) => {
      console.debug("[Injected] Active Elitical pull failed", error.message);
    });

    const apiRecords = state.records.filter((record) => record.status >= 200 && record.status < 400);
    const diagnostics = {
      identityHints: Boolean(readIdentityHints().id || readIdentityHints().name),
      injected: true,
      fetchPatched: state.fetchPatched,
      xhrPatched: state.xhrPatched,
      records: state.records.length,
      endpoints: uniqueById(
        state.records.map((record) => ({ id: record.endpoint, title: record.endpoint }))
      ).map((record) => record.id),
      hasUserSession: Boolean(latestRecord("UserSessionDto")),
      hasEmployee: Boolean(latestRecord("Employee")),
      hasProject: Boolean(latestRecord("Project")),
      hasSprint: Boolean(latestRecord("Sprint")),
      hasDocket: Boolean(latestRecord("Docket") || latestRecord("Board")),
      hasWorklog: Boolean(latestRecord("Worklog")),
      warnings: [],
    };

    if (state.records.length === 0) {
      return {
        ok: false,
        error:
          "No authenticated API requests detected. Refresh Elitical once after logging in, then click Sync.",
        diagnostics,
      };
    }

    if (!diagnostics.hasWorklog) {
      diagnostics.warnings.push(
        "No worklog endpoints observed yet. Syncing available Elitical data with 0 worklogs."
      );
    }

    const employee = normalizeEmployee();

    if (!employee?.id) {
      return {
        ok: false,
        error: "Authenticated employee profile could not be identified from captured responses.",
        diagnostics,
      };
    }

    const project = normalizeProject() || { id: "", name: "" };
    const sprint = normalizeSprint() || { id: "", name: "" };
    const docketObjects = apiRecords
      .filter((record) => /docket|board/i.test(record.endpoint))
      .flatMap((record) =>
        objectsFrom([record])
          .filter((item) => firstString(item?.id, item?.docketId, item?.cx))
          .filter(
            (item) =>
              belongsToEmployee(item, employee) ||
              isVisibleDocketRecord(record)
          )
      );
    const worklogRecords = apiRecords.filter((record) => /worklog/i.test(record.endpoint));
    const worklogObjects = worklogRecords.flatMap((record) =>
      objectsFrom([record])
        .filter((item) =>
          firstString(item?.id, item?.worklogId, item?.cx, item?.worklogDate, item?.date)
        )
        .map((item) => ({
          ...item,
          __employeeScopedEndpoint: /worklog\/employee/i.test(record.endpoint),
        }))
    );
    const summaryObjects = worklogRecords.flatMap((record) =>
      objectsFrom([record]).filter(looksLikeWorklogSummary)
    );
    const endpointSummaries =
      worklogObjects.length === 0 && summaryObjects.length === 0
        ? worklogRecords.map(worklogRecordSummary)
        : [];
    const worklogs = uniqueById(
      [...worklogObjects, ...summaryObjects, ...endpointSummaries]
        .filter(
          (item) =>
            belongsToEmployee(item, employee) ||
            item.__employeeScopedEndpoint ||
            firstString(item?.employeeId, item?.empId) === employee.id ||
            firstString(item?.employee?.id, item?.employee?.employeeId) === employee.id ||
            !firstString(item?.employeeId, item?.empId, item?.employee?.id)
        )
        .map((item, index) =>
          looksLikeWorklogSummary(item)
            ? normalizeWorklogSummary(item, index)
            : normalizeWorklog(item)
        )
    );
    const epics = uniqueById(docketObjects.filter((item) => itemType(item) === "epic").map(normalizeDocket));
    const stories = uniqueById(docketObjects.filter((item) => itemType(item) === "story").map(normalizeDocket));
    const jobs = uniqueById(docketObjects.filter((item) => itemType(item) === "job").map(normalizeDocket));
    const syncedAt = new Date().toISOString();

    return {
      ok: true,
      diagnostics,
      payload: {
        schemaVersion: SCHEMA_VERSION,
        source: SOURCE,
        syncedAt,
        employee,
        project,
        sprint,
        epics,
        stories,
        jobs,
        worklogs,
        counts: {
          epics: epics.length,
          stories: stories.length,
          jobs: jobs.length,
          worklogs: worklogs.length,
        },
      },
    };
  }

  async function handleRequest(event) {
    const requestId = event.detail?.requestId;

    if (!requestId) return;

    const result = await buildSnapshot();

    console.debug("[Injected] Snapshot requested", {
      ok: result.ok,
      error: result.error || "",
      diagnostics: result.diagnostics,
    });

    eventTarget().dispatchEvent(
      new CustomEvent(RESPONSE_EVENT, {
        detail: { requestId, ...result },
      })
    );
  }

  patchFetch();
  patchXhr();
  eventTarget().setAttribute?.(READY_ATTR, "ready");
  eventTarget().addEventListener(REQUEST_EVENT, handleRequest);

  console.debug("[Injected] Elitical API interceptor installed", {
    fetchPatched: state.fetchPatched,
    xhrPatched: state.xhrPatched,
  });

  eventTarget().dispatchEvent(new CustomEvent(READY_EVENT));
})();
