import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Shared list query params (API_CONTRACT.md): page/pageSize, sortBy/sortOrder,
 * search. Provided by the Configuration foundation.
 */
export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize = 20;

  @IsOptional()
  @IsString()
  sortBy?: string;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder: 'asc' | 'desc' = 'asc';

  @IsOptional()
  @IsString()
  search?: string;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** Build a Paginated<T> envelope payload from a page of rows + total count. */
export function paginate<T>(items: T[], total: number, page: number, pageSize: number): Paginated<T> {
  return {
    items,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** Resolve a validated sort column against an allow-list (prevents injection). */
export function resolveSort<T extends string>(
  sortBy: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(sortBy as T) ? (sortBy as T) : fallback;
}
