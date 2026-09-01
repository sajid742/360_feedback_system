import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditRecordInput {
  organizationId: string;
  userId: string;
  action: string;
  entityType: string;
  entityId: string;
  previousValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
  ip?: string | null;
  device?: string | null;
}

/**
 * Writes an immutable audit row on every mutation (handoff §6). Provided by the
 * Configuration foundation; the `audit_logs` table already exists. Failures are
 * swallowed so auditing never breaks the primary operation, but are surfaced to
 * the logger for follow-up.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditRecordInput): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        organizationId: input.organizationId,
        userId: input.userId,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        previousValue: input.previousValue === undefined ? undefined : (input.previousValue as object),
        newValue: input.newValue === undefined ? undefined : (input.newValue as object),
        reason: input.reason ?? null,
        ip: input.ip ?? null,
        device: input.device ?? null,
      },
    });
  }
}
