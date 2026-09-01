import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { requestCached } from '../common/context/request-context';
import type { AuthUser } from '../common/auth/current-user';

/**
 * Record-level visibility for the RBAC data scope carried on the token:
 *  - organization → all employees in the org (no restriction)
 *  - reporting     → the user's own employee + everyone below them in the reporting tree
 *  - own           → the user's own employee only
 * Used to restrict the employee directory, individual reports and own-data reads.
 */
@Injectable()
export class ScopeService {
  constructor(private readonly prisma: PrismaService) {}

  /** Set of employee ids the user may see, or `null` for unrestricted (organization scope). */
  async visibleEmployeeIds(user: AuthUser): Promise<Set<string> | null> {
    if (user.scope === 'organization') return null;
    if (!user.employeeId) return new Set(); // restricted scope but no employee anchor → nothing
    if (user.scope === 'own') return new Set([user.employeeId]);

    // reporting: the user's own employee + everyone beneath them in the line-manager tree.
    //
    // Performance (F-P3): this used to load EVERY employee in the organization on
    // every scoped request and walk the tree in JavaScript, building the child map
    // with `[...(get() ?? []), id]` — an O(n²) copy per node. For a 1,500-person org
    // that is 1,500 rows fetched and thousands of array copies just to answer "may I
    // see this person?", repeated on every request. Postgres now walks the subtree
    // and returns only the visible ids, and the result is memoised for the request
    // because assertCanAccessEmployee is typically called several times per request.
    const anchor = user.employeeId;
    return requestCached(`scope:${user.organizationId}:${anchor}`, async () => {
      const rows = await this.prisma.$queryRaw<{ id: string }[]>`
        WITH RECURSIVE subtree AS (
          SELECT id FROM employees
           WHERE id = ${anchor}::uuid
             AND organization_id = ${user.organizationId}::uuid
             AND deleted_at IS NULL
          UNION
          SELECT e.id FROM employees e
            JOIN subtree s ON e.line_manager_id = s.id
           WHERE e.organization_id = ${user.organizationId}::uuid
             AND e.deleted_at IS NULL
        )
        SELECT id FROM subtree`;
      return new Set(rows.map((r) => r.id));
    });
  }

  /** Throw 403 unless the user may access the given employee's records. */
  async assertCanAccessEmployee(user: AuthUser, employeeId: string): Promise<void> {
    const visible = await this.visibleEmployeeIds(user);
    if (visible === null) return; // organization scope
    if (!visible.has(employeeId)) {
      throw new ForbiddenException('You do not have access to this employee’s data.');
    }
  }
}
