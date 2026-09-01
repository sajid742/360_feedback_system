import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { type SisSnapshot } from './sis-snapshot.types';

/**
 * The persisted per-organization SIS dataset (one row per org, JSON snapshot).
 * `StoredSisProvider` reads it to serve the existing SisProvider interface; the
 * import/sync engine writes it. A missing row means the org has no synced roster
 * yet (the tenant-aware binding then falls back to the legacy provider).
 */
@Injectable()
export class SisDatasetService {
  constructor(private readonly prisma: PrismaService) {}

  async get(organizationId: string): Promise<SisSnapshot | null> {
    const row = await this.prisma.sisDataset.findUnique({ where: { organizationId }, select: { snapshot: true } });
    return (row?.snapshot as unknown as SisSnapshot) ?? null;
  }

  /** The dataset row's own id — the audit trail's entity, since `audit_logs.entity_id` is a UUID
   *  and a roster record's id (`S1000`, `PA0-1`) is not one. The record id travels in the value. */
  async id(organizationId: string): Promise<string | null> {
    const row = await this.prisma.sisDataset.findUnique({ where: { organizationId }, select: { id: true } });
    return row?.id ?? null;
  }

  async has(organizationId: string): Promise<boolean> {
    return (await this.prisma.sisDataset.count({ where: { organizationId } })) > 0;
  }

  async meta(organizationId: string): Promise<{ provider: string; studentCount: number; teacherCount: number; updatedAt: Date } | null> {
    const row = await this.prisma.sisDataset.findUnique({ where: { organizationId }, select: { provider: true, studentCount: true, teacherCount: true, updatedAt: true } });
    return row ?? null;
  }

  async save(organizationId: string, provider: string, snapshot: SisSnapshot, userId: string | null): Promise<void> {
    const value = snapshot as unknown as Prisma.InputJsonValue;
    const data = { provider, snapshot: value, studentCount: snapshot.students.length, teacherCount: snapshot.teachers.length, updatedBy: userId };
    await this.prisma.sisDataset.upsert({
      where: { organizationId },
      update: data,
      create: { organizationId, ...data },
    });
  }
}
