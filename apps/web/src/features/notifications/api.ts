import { apiClient } from '@/lib/api-client';

/**
 * Where a notification lets the user act. Supplied by the server, which is the only
 * place that decides whether an action exists and whether this user may reach it.
 */
export interface NotificationAction {
  /** Internal route. The bell refuses anything that is not an in-app absolute path. */
  route: string;
  /** Short verb for the affordance, e.g. "Give feedback". */
  label: string;
}

export interface UserNotification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  /**
   * Legacy field, retained for compatibility. NOT a navigation target — see `action`.
   * Optional so that an older API build, which omits `action`/`actionable`, degrades
   * to "informational" rather than breaking.
   */
  link: string | null;
  actionable?: boolean;
  action?: NotificationAction | null;
  read: boolean;
  createdAt: string;
}

export const notificationsApi = {
  list: (): Promise<UserNotification[]> => apiClient.get('/notifications'),
  unreadCount: (): Promise<{ count: number }> => apiClient.get('/notifications/unread-count'),
  markRead: (id: string): Promise<{ id: string }> => apiClient.post(`/notifications/${id}/read`),
  markAllRead: (): Promise<{ updated: number }> => apiClient.post('/notifications/read-all'),
};
