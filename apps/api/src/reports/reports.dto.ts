import { IsIn, IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';

/**
 * Admin-editable feedback rules (F-C4). Bounds are deliberately conservative:
 * a min-responses threshold below 2 would defeat rater anonymity entirely, and a
 * target score must stay inside a normal rating range.
 */
export class UpdateFeedbackRulesDto {
  /** Who may see organisation-wide aggregate reports (F15). */
  @IsOptional() @IsIn(['all_report_viewers', 'executives_only'])
  aggregateVisibility?: 'all_report_viewers' | 'executives_only';

  /** Expected/target competency score used for readiness, gaps and at-risk lists. */
  @IsOptional() @IsNumber() @Min(1) @Max(10)
  targetScore?: number;

  /** Minimum distinct reviewers before a non-self source is shown (anonymity threshold). */
  @IsOptional() @IsInt() @Min(2) @Max(20)
  minResponsesToShow?: number;

  /* -- Shared-competency comparison thresholds, in rating-scale units -- */

  /** Difference between two quadrants worth noting. Default 0.5. */
  @IsOptional() @IsNumber() @Min(0.05) @Max(3)
  gapModerate?: number;

  /** Difference worth investigating. Default 1.0. */
  @IsOptional() @IsNumber() @Min(0.1) @Max(4)
  gapPronounced?: number;

  /** Standard deviation across quadrants at or below which groups are said to agree. Default 0.30. */
  @IsOptional() @IsNumber() @Min(0.01) @Max(2)
  consensusSdLow?: number;

  /** Standard deviation at or above which perceptions are said to diverge. Default 0.75. */
  @IsOptional() @IsNumber() @Min(0.05) @Max(3)
  consensusSdHigh?: number;

  /** Visible quadrants required before any comparison verdict is given. Default 2. */
  @IsOptional() @IsInt() @Min(2) @Max(6)
  comparisonMinQuadrants?: number;
}
