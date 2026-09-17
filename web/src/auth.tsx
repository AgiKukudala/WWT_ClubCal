import { useQueryClient } from "@tanstack/react-query";
import type { MeDTO } from "@clubcal/shared";
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { api } from "./api/client";
import { useSession } from "./api/hooks";
import { ErrorState, Spinner } from "./components/ui";

export function useMe(): MeDTO | null {
  return useSession().data?.user ?? null;
}

/** Returns the signed-in user; only use below <RequireAuth>. */
export function useUser(): MeDTO {
  const me = useMe();
  if (!me) throw new Error("useUser used outside an authenticated route");
  return me;
}

export const canManageClub = (me: MeDTO, clubId: string) => me.role === "admin" || (me.role === "organizer" && me.organizerClubIds.includes(clubId));
export const isManager = (me: MeDTO) => me.role === "admin" || (me.role === "organizer" && me.organizerClubIds.length > 0);

export function RequireAuth({ children, roles }: { children: ReactNode; roles?: MeDTO["role"][] }) {
  const session = useSession();
  const location = useLocation();
  if (session.isPending) return <Spinner label="Checking your session…" />;
  if (session.isError) return <ErrorState error={session.error} onRetry={() => session.refetch()} />;
  const user = session.data.user;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (roles && !roles.includes(user.role)) {
    return (
      <div className="state error" role="alert">
        <strong>You don't have access to this page.</strong>
      </div>
    );
  }
  return <>{children}</>;
}

export function useSignOut() {
  const qc = useQueryClient();
  return async () => {
    try {
      await api.post("/api/auth/logout");
    } finally {
      qc.clear();
      window.location.assign("/login");
    }
  };
}
