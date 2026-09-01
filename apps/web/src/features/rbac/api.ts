import { apiClient } from '@/lib/api-client';

export interface RbacRole { id: string; name: string; description: string | null; scope: string; isSystem: boolean; users: number; permissions: string[]; permissionCount: number }
export interface RbacUser {
  id: string; name: string; email: string; status: string;
  roles: { id: string; name: string }[]; isSuperAdmin: boolean;
  employeeCode: string | null; department: string | null; designation: string | null;
}
export interface RbacUserPage { items: RbacUser[]; page: number; pageSize: number; total: number; totalPages: number }
export interface RbacUserDetail {
  id: string; name: string; email: string; status: string;
  roles: { id: string; name: string; scope: string }[]; scope: string; permissions: string[];
}
export interface PermGroup { module: string; label: string; permissions: { code: string; description: string; action: string }[] }
export interface Matrix {
  roles: { id: string; name: string; scope: string; permissionCount: number }[];
  groups: PermGroup[];
  grants: Record<string, string[]>;
}

export const rbacApi = {
  roles: (): Promise<RbacRole[]> => apiClient.get('/rbac/roles'),
  matrix: (): Promise<Matrix> => apiClient.get('/rbac/matrix'),
  users: (params: { search?: string; roleId?: string; status?: string; page?: number; pageSize?: number }): Promise<RbacUserPage> =>
    apiClient.get('/rbac/users', params),
  user: (id: string): Promise<RbacUserDetail> => apiClient.get(`/rbac/users/${id}`),
  setRoles: (id: string, roleIds: string[]): Promise<RbacUserDetail> => apiClient.put(`/rbac/users/${id}/roles`, { roleIds }),
  setActive: (id: string, active: boolean): Promise<{ id: string; status: string }> => apiClient.post(`/rbac/users/${id}/active`, { active }),
  invite: (id: string): Promise<{ userId: string; email: string; sent: boolean; reason?: string }> =>
    apiClient.post(`/rbac/users/${id}/invite`),
  resetPassword: (id: string, body: { temporaryPassword?: string; requireChange?: boolean }): Promise<{ userId: string; temporaryPassword: string; requireChange: boolean }> =>
    apiClient.post(`/rbac/users/${id}/reset-password`, body),
};
