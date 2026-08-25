// Shared enums mirrored from the Prisma schema so worker + api stay in sync
export enum JobStatus {
  PENDING = 'PENDING',
  SCHEDULED = 'SCHEDULED',
  CLAIMED = 'CLAIMED',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  RETRYING = 'RETRYING',
  CANCELLED = 'CANCELLED',
  DEAD = 'DEAD',
}

export enum RetryStrategy {
  FIXED = 'FIXED',
  LINEAR = 'LINEAR',
  EXPONENTIAL = 'EXPONENTIAL',
}

export enum WorkerStatus {
  ACTIVE = 'ACTIVE',
  IDLE = 'IDLE',
  DEAD = 'DEAD',
  DRAINING = 'DRAINING',
}

export enum OrgRole {
  OWNER = 'OWNER',
  ADMIN = 'ADMIN',
  MEMBER = 'MEMBER',
  VIEWER = 'VIEWER',
}

export enum ExecutionStatus {
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  TIMEOUT = 'TIMEOUT',
  CANCELLED = 'CANCELLED',
}

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: PaginationMeta & Record<string, unknown>;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown[];
  };
}

export type Role = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

export const ROLE_HIERARCHY: Record<Role, number> = {
  VIEWER: 0,
  MEMBER: 1,
  ADMIN: 2,
  OWNER: 3,
};

/** True when the member's role satisfies the minimum required role. */
export function hasMinRole(memberRole: string, required: Role): boolean {
  const actual = ROLE_HIERARCHY[memberRole as Role];
  const min = ROLE_HIERARCHY[required];
  if (actual === undefined || min === undefined) return false;
  return actual >= min;
}
