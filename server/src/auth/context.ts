import type { Role } from "@clubcal/shared";
import type { User } from "../db/types.js";
import { forbidden, unauthorized } from "../lib/errors.js";

export interface Actor {
  user: User;
  sessionId: string;
  csrfToken: string;
  /** Clubs this user may manage (only populated for organizers). */
  organizerClubIds: Set<string>;
  /** Clubs this user belongs to in any role. */
  memberClubIds: Set<string>;
}

declare module "express-serve-static-core" {
  interface Request {
    actor?: Actor;
  }
}

export const isAdmin = (a: Actor) => a.user.role === "admin";

export function canManageClub(a: Actor, clubId: string): boolean {
  if (isAdmin(a)) return true;
  return a.user.role === "organizer" && a.organizerClubIds.has(clubId);
}

export function assertCanManageClub(a: Actor, clubId: string) {
  if (!canManageClub(a, clubId)) throw forbidden("Only this club's organizers or an administrator can do that.");
}

export function requireActor(a: Actor | undefined): Actor {
  if (!a) throw unauthorized();
  return a;
}

export function assertRole(a: Actor, ...roles: Role[]) {
  if (!roles.includes(a.user.role)) throw forbidden();
}
