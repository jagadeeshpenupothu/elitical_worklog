import type { Issue } from "./issue.js";
import type { Worklog } from "./worklog.js";

export interface Docket extends Issue {
  sprint?: string;
  comments?: unknown[];
  worklogs?: Worklog[];
}
