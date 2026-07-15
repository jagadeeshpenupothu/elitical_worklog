export interface EliticalSession {
  token?: string;
  authorization?: string;
  sJwtToken?: string;
  sessionId?: string;
  employeeId?: string;
  projectId?: string;
  authenticatedAt?: string;
}

export interface EliticalUser {
  id?: string;
  employeeId?: string;
  empId?: string;
  name?: string;
  displayName?: string;
  fullName?: string;
  employeeName?: string;
  empName?: string;
  userName?: string;
  userNameSession?: string;
  email?: string;
  emailId?: string;
}
