import { apiClient, type Paginated } from '@/lib/api-client';

export interface Ref {
  id: string;
  name: string;
}

export interface Employee {
  id: string;
  employeeCode: string;
  status: string;
  joinDate: string | null;
  user: { id: string; email: string; fullName: string | null };
  department: Ref | null;
  designation: Ref | null;
  campusId: string | null;
  lineManagerId: string | null;
  lineManager: Ref | null;
  matrixManagers: Ref[];
}

export interface DepartmentNode {
  id: string;
  name: string;
  unitType: string;
  parentId: string | null;
  campusName: string | null;
  hodName: string | null;
  hodDesignation: string | null;
  employeeCount: number;
  totalEmployeeCount: number;
  children: DepartmentNode[];
}

export interface Designation {
  id: string;
  name: string;
  level: number;
  promotionToId: string | null;
}

export interface Campus {
  id: string;
  name: string;
  slug: string;
  status: string;
}

export interface CreateEmployeeInput {
  email: string;
  fullName: string;
  employeeCode: string;
  password?: string;
  /** Organisation unit. Without it the person is "Unassigned" in every departmental report. */
  departmentId?: string;
  designationId?: string;
  campusId?: string;
  /** Reporting line. Drives data scope, the org chart and evaluator derivation. */
  lineManagerId?: string;
  joinDate?: string;
  /** Email a set-password invitation instead of issuing a temporary password (F28). */
  sendInvite?: boolean;
}

/**
 * Placement edit. `null` clears the field, `undefined` leaves it as it was — the server
 * distinguishes the two (`dto.x === undefined ? existing.x : dto.x`), so "— Unassigned —"
 * has to travel as an explicit null or the field could never be emptied again.
 */
export interface UpdateEmployeeInput {
  departmentId?: string | null;
  designationId?: string | null;
  campusId?: string | null;
  lineManagerId?: string | null;
  status?: string;
}

/** What the API returns after creating an employee: the credential handover. */
export interface CreatedEmployee extends Employee {
  temporaryPassword: string | null;
  invitation?: { sent: boolean; reason?: string };
  roleAssigned: string | null;
}

export const orgApi = {
  listEmployees: (search: string): Promise<Paginated<Employee>> =>
    apiClient.get('/organization/employees', { search, page: 1, pageSize: 100 }),
  createEmployee: (input: CreateEmployeeInput): Promise<CreatedEmployee> =>
    apiClient.post('/organization/employees', input),
  updateEmployee: (id: string, input: UpdateEmployeeInput): Promise<Employee> =>
    apiClient.put(`/organization/employees/${id}`, input),
  assignMatrix: (id: string, managerIds: string[]): Promise<void> =>
    apiClient.post(`/organization/employees/${id}/matrix`, { managerIds }),
  terminate: (id: string): Promise<void> => apiClient.delete(`/organization/employees/${id}`),
  orgChart: (): Promise<Employee[]> => apiClient.get('/organization/org-chart'),

  deptTree: (): Promise<DepartmentNode[]> => apiClient.get('/organization/departments/tree'),
  createDept: (input: { name: string; parentId?: string; unitType?: string }): Promise<{ id: string }> =>
    apiClient.post('/organization/departments', input),
  deleteDept: (id: string): Promise<void> => apiClient.delete(`/organization/departments/${id}`),

  listDesignations: (): Promise<Designation[]> => apiClient.get('/organization/designations'),
  createDesignation: (input: { name: string; level?: number; promotionToId?: string }): Promise<{ id: string }> =>
    apiClient.post('/organization/designations', input),
  deleteDesignation: (id: string): Promise<void> => apiClient.delete(`/organization/designations/${id}`),

  listCampuses: (): Promise<Campus[]> => apiClient.get('/organization/campuses'),
  createCampus: (input: { name: string; slug: string }): Promise<{ id: string }> =>
    apiClient.post('/organization/campuses', input),
  deleteCampus: (id: string): Promise<void> => apiClient.delete(`/organization/campuses/${id}`),
};
