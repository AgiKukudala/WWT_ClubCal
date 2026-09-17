import type { ConflictDetail } from "@clubcal/shared";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: { fields?: Record<string, string[]>; conflicts?: ConflictDetail[]; currentVersion?: number } = {},
  ) {
    super(message);
  }
}

export const badRequest = (message: string, fields?: Record<string, string[]>) =>
  new HttpError(400, "bad_request", message, { fields });
export const unauthorized = (message = "Please sign in.") => new HttpError(401, "unauthorized", message);
export const forbidden = (message = "You do not have permission to do that.") => new HttpError(403, "forbidden", message);
export const notFound = (what = "Resource") => new HttpError(404, "not_found", `${what} not found.`);
export const conflict = (message: string, conflicts?: ConflictDetail[]) =>
  new HttpError(409, "conflict", message, { conflicts });
export const versionConflict = (currentVersion: number) =>
  new HttpError(
    409,
    "version_conflict",
    "This event was changed by someone else after you opened it. Reload to see the latest version, then reapply your edit.",
    { currentVersion },
  );
export const tooManyRequests = (message: string) => new HttpError(429, "rate_limited", message);

/** PostgreSQL error helpers. */
export function pgCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined;
}
export function pgConstraint(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "constraint" in err
    ? String((err as { constraint: unknown }).constraint)
    : undefined;
}
export const isExclusionViolation = (err: unknown) => pgCode(err) === "23P01";
export const isUniqueViolation = (err: unknown) => pgCode(err) === "23505";
export const isSerializationFailure = (err: unknown) => pgCode(err) === "40001" || pgCode(err) === "40P01";
