import type { z } from "zod";
import { badRequest } from "../lib/errors.js";

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const fields: Record<string, string[]> = {};
  for (const issue of r.error.issues) {
    const key = issue.path.join(".") || "_";
    (fields[key] ??= []).push(issue.message);
  }
  const first = r.error.issues[0];
  throw badRequest(first ? `${first.path.length ? `${first.path.join(".")}: ` : ""}${first.message}` : "Invalid request", fields);
}

export const idParam = (v: unknown): string => {
  if (typeof v !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
    throw badRequest("Invalid id");
  }
  return v;
};
