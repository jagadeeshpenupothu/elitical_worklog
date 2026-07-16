export interface Worklog {
  id?: string;
  worklogId?: string;
  cx?: string;
  docketId?: string;
  docket?: {
    id?: string;
  };
  employeeId?: string;
  empId?: string;
  employee?: {
    id?: string;
    employeeId?: string;
  };
  projectId?: string;
  project?: {
    id?: string;
  };
  worklogDate?: string;
  date?: string;
  createdDate?: string;
  minutes?: number;
  loggedMinutes?: number;
  hours?: number;
  loggedHours?: number;
  duration?: number;
  comment?: string;
  note?: string;
  description?: string;
}
