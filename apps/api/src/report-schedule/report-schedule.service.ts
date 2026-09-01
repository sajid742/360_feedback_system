import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import type { AuthUser } from '../common/auth/current-user';
import { ReportsService } from '../reports/services/reports.service';
import { NotificationService } from '../communication/services/notification.service';
import type { CreateScheduleDto } from './report-schedule.dto';

const INTERVAL_DAYS: Record<string, number> = { daily: 1, weekly: 7, monthly: 30 };

/**
 * Scheduled report digests (NH-2). A daily cron emails a concise summary of the
 * chosen report to its recipients, honouring each schedule's cadence. Composes
 * the existing Reports aggregates + Communication layer — no new report logic.
 */
@Injectable()
export class ReportScheduleService {
  private readonly logger = new Logger(ReportScheduleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: ReportsService,
    private readonly notifications: NotificationService,
  ) {}

  async list(user: AuthUser): Promise<Record<string, unknown>[]> {
    const rows = await this.prisma.reportSchedule.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      reportType: r.reportType,
      frequency: r.frequency,
      recipients: r.recipients,
      cycleId: r.cycleId,
      isActive: r.isActive,
      lastRunAt: r.lastRunAt,
      createdAt: r.createdAt,
    }));
  }

  async create(user: AuthUser, dto: CreateScheduleDto): Promise<{ id: string }> {
    const row = await this.prisma.reportSchedule.create({
      data: {
        organizationId: user.organizationId,
        name: dto.name,
        reportType: dto.reportType,
        frequency: dto.frequency,
        recipients: dto.recipients,
        cycleId: dto.cycleId ?? null,
        createdBy: user.userId,
      },
    });
    return { id: row.id };
  }

  async remove(user: AuthUser, id: string): Promise<void> {
    const existing = await this.prisma.reportSchedule.findFirst({ where: { id, organizationId: user.organizationId }, select: { id: true } });
    if (!existing) throw new NotFoundException('Schedule not found.');
    await this.prisma.reportSchedule.delete({ where: { id } });
  }

  /** Send one schedule's digest now (manual "run" button). */
  async runNow(user: AuthUser, id: string): Promise<{ sent: number }> {
    const schedule = await this.prisma.reportSchedule.findFirst({ where: { id, organizationId: user.organizationId } });
    if (!schedule) throw new NotFoundException('Schedule not found.');
    return { sent: await this.dispatch(schedule) };
  }

  @Cron(CronExpression.EVERY_DAY_AT_7AM)
  async runScheduled(): Promise<void> {
    const schedules = await this.prisma.reportSchedule.findMany({ where: { isActive: true } });
    const now = Date.now();
    for (const s of schedules) {
      const intervalMs = (INTERVAL_DAYS[s.frequency] ?? 7) * 24 * 60 * 60 * 1000;
      const due = !s.lastRunAt || now - s.lastRunAt.getTime() >= intervalMs;
      if (!due) continue;
      try {
        await this.dispatch(s);
      } catch (error) {
        this.logger.warn(`Report schedule ${s.id} failed: ${(error as Error).message}`);
      }
    }
  }

  private async dispatch(schedule: {
    id: string;
    organizationId: string;
    name: string;
    reportType: string;
    recipients: string[];
    cycleId: string | null;
  }): Promise<number> {
    const body = await this.buildDigest(schedule.organizationId, schedule.reportType, schedule.cycleId ?? undefined);
    let sent = 0;
    for (const recipient of schedule.recipients) {
      await this.notifications.send(schedule.organizationId, null, {
        channel: 'email',
        recipient,
        subject: `360° report digest: ${schedule.name}`,
        body,
        templateKey: 'reports.digest',
      });
      sent++;
    }
    await this.prisma.reportSchedule.update({ where: { id: schedule.id }, data: { lastRunAt: new Date() } });
    return sent;
  }

  private async buildDigest(orgId: string, reportType: string, cycleId?: string): Promise<string> {
    if (reportType === 'departmental') {
      const rows = (await this.reports.departmental(orgId, cycleId)) as unknown as {
        department: string;
        participants: number;
        completionPct: number;
        avgScore: number | null;
      }[];
      const lines = rows.map((r) => `• ${r.department}: ${r.participants} participants, ${r.completionPct}% complete, avg ${r.avgScore ?? '—'}`);
      return `Departmental 360° summary\n\n${lines.join('\n') || 'No data yet.'}`;
    }
    const data = (await this.reports.institutional(orgId, cycleId)) as unknown as {
      participation: { total: number; completed: number; completionPct: number };
      avgScore: number | null;
    };
    return [
      'Institutional 360° summary',
      '',
      `Participants: ${data.participation.total}`,
      `Completed: ${data.participation.completed} (${data.participation.completionPct}%)`,
      `Average score: ${data.avgScore ?? '—'}`,
    ].join('\n');
  }
}
