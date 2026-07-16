import type { Issue } from "./issue";
import type { Worklog } from "./worklog";

export interface Docket extends Issue {
  sprint?: string;
  comments?: unknown[];
  worklogs?: Worklog[];
}
