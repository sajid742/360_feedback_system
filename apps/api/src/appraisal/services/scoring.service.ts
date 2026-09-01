import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuditService } from '../../common/audit/audit.service';
import { FeedbackAuditService } from '../../feedback-audit/feedback-audit.service';
import type { AuthUser, RequestContext } from '../../common/auth/current-user';

/** Weighted 360 scoring: per source, average the rating responses across its
 *  submitted assignments; combine sources by their configured weight. */
@Injectable()
export class ScoringService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly feedbackAudit: FeedbackAuditService,
  ) {}

  /**
   * Recompute the weighted score from submitted feedback.
   *
   * If HR has calibrated (manually overridden) this participant, that override is
   * authoritative and is NOT replaced (F-C6). Previously any late submission
   * silently reverted an approved calibrated score to the raw average and reset the
   * participant out of 'completed', leaving the audit trail describing a calibration
   * that no longer matched the stored data. The newly computed value is still saved
   * to `computedScore` so the underlying average stays visible.
   */
  async compute(participantId: string): Promise<number | null> {
    const existing = await this.prisma.appraisalParticipant.findUnique({
      where: { id: participantId },
      select: { calibratedAt: true, finalScore: true },
    });
    // Only APPROVED reviewers count toward the score (F-H3) — a pending or rejected
    // nomination must never influence an appraisee's result.
    const assignments = await this.prisma.reviewerAssignment.findMany({
      where: { participantId, status: 'submitted', nominationStatus: 'approved' },
      include: { source: { select: { weight: true } }, responses: { where: { ratingValue: { not: null } } } },
    });
    const bySource = new Map<string, { weight: number; sum: number; count: number }>();
    for (const a of assignments) {
      const bucket = bySource.get(a.sourceId) ?? { weight: Number(a.source.weight), sum: 0, count: 0 };
      for (const r of a.responses) {
        bucket.sum += Number(r.ratingValue);
        bucket.count += 1;
      }
      bySource.set(a.sourceId, bucket);
    }

    let weightedSum = 0;
    let weightTotal = 0;
    for (const bucket of bySource.values()) {
      if (bucket.count === 0) continue;
      weightedSum += (bucket.sum / bucket.count) * bucket.weight;
      weightTotal += bucket.weight;
    }
    const score = weightTotal > 0 ? Math.round((weightedSum / weightTotal) * 100) / 100 : null;

    // A calibrated participant keeps the HR-approved score and 'completed' status;
    // only the underlying computed value is refreshed.
    if (existing?.calibratedAt) {
      await this.prisma.appraisalParticipant.update({
        where: { id: participantId },
        data: { computedScore: score },
      });
      return existing.finalScore !== null ? Number(existing.finalScore) : null;
    }

    await this.prisma.appraisalParticipant.update({
      where: { id: participantId },
      data: { finalScore: score, computedScore: score, status: score !== null ? 'in_progress' : 'pending' },
    });
    return score;
  }

  async calibrate(user: AuthUser, ctx: RequestContext, participantId: string, finalScore: number, reason?: string): Promise<void> {
    const participant = await this.prisma.appraisalParticipant.findFirst({
      where: { id: participantId, cycle: { organizationId: user.organizationId } },
      select: { id: true, finalScore: true },
    });
    if (!participant) throw new NotFoundException('Participant not found.');
    // Mark as calibrated so later recomputation cannot silently revert it (F-C6).
    await this.prisma.appraisalParticipant.update({
      where: { id: participantId },
      data: { finalScore, status: 'completed', calibratedAt: new Date() },
    });
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action: 'appraisal.calibrate',
      entityType: 'appraisal_participant',
      entityId: participantId,
      previousValue: { finalScore: participant.finalScore ? Number(participant.finalScore) : null },
      newValue: { finalScore },
      reason: reason ?? null,
      ip: ctx.ip,
      device: ctx.device,
    });
    // Feedback trail: an administrative override/correction of the final score.
    await this.feedbackAudit.record({
      organizationId: user.organizationId,
      action: 'score.calibrated',
      actorUserId: user.userId,
      actorName: user.email,
      ...(await this.feedbackAudit.participantContext(participantId)),
      entityType: 'appraisal_participant',
      entityId: participantId,
      previousValue: { finalScore: participant.finalScore ? Number(participant.finalScore) : null },
      newValue: { finalScore },
      reason: reason ?? null,
      ctx,
    });
  }

  /** Set a participant's potential rating (nine-box grid, NH-1). */
  async setPotential(user: AuthUser, ctx: RequestContext, participantId: string, potential: number): Promise<{ id: string; potentialRating: number }> {
    const participant = await this.prisma.appraisalParticipant.findFirst({
      where: { id: participantId, cycle: { organizationId: user.organizationId } },
      select: { id: true },
    });
    if (!participant) throw new NotFoundException('Participant not found.');
    await this.prisma.appraisalParticipant.update({ where: { id: participantId }, data: { potentialRating: potential } });
    await this.audit.record({
      organizationId: user.organizationId,
      userId: user.userId,
      action: 'appraisal.potential',
      entityType: 'appraisal_participant',
      entityId: participantId,
      newValue: { potentialRating: potential },
      ip: ctx.ip,
      device: ctx.device,
    });
    await this.feedbackAudit.record({
      organizationId: user.organizationId,
      action: 'potential.set',
      actorUserId: user.userId,
      actorName: user.email,
      ...(await this.feedbackAudit.participantContext(participantId)),
      entityType: 'appraisal_participant',
      entityId: participantId,
      newValue: { potentialRating: potential },
      ctx,
    });
    return { id: participantId, potentialRating: potential };
  }
}
