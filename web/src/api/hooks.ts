import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AttendeeDTO,
  AuditEntryDTO,
  ClubMemberDTO,
  ClubSummaryDTO,
  FindTimesResultDTO,
  JobHealthDTO,
  NotificationDTO,
  OccurrenceDTO,
  OccurrencePage,
  RoomDTO,
  RsvpStatus,
  SeriesDTO,
  SessionDTO,
  UserSummaryDTO,
} from "@clubcal/shared";
import { api, qs, setCsrfToken } from "./client";

/** Calendar data and notification counts refresh every 20 s while the tab is visible. */
export const POLL_MS = 20_000;

export function useSession() {
  return useQuery({
    queryKey: ["session"],
    queryFn: async () => {
      const s = await api.get<SessionDTO>("/api/auth/session");
      setCsrfToken(s.csrfToken);
      return s;
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });
}

export interface OccurrenceParams {
  from: string;
  to: string;
  clubId?: string;
  roomId?: string;
  category?: string;
  q?: string;
  status?: string;
  mine?: boolean;
  limit?: number;
  cursor?: string;
}

export function useOccurrences(params: OccurrenceParams, enabled = true) {
  return useQuery({
    queryKey: ["occurrences", params],
    queryFn: () => api.get<OccurrencePage>(`/api/occurrences${qs({ ...params, mine: params.mine ? "true" : undefined })}`),
    placeholderData: keepPreviousData,
    refetchInterval: POLL_MS,
    enabled,
  });
}

export function useOccurrence(id: string | undefined) {
  return useQuery({
    queryKey: ["occurrence", id],
    queryFn: () => api.get<OccurrenceDTO>(`/api/occurrences/${id}`),
    enabled: Boolean(id),
    refetchInterval: POLL_MS,
  });
}

export function useSeries(id: string | undefined) {
  return useQuery({ queryKey: ["series", id], queryFn: () => api.get<SeriesDTO>(`/api/series/${id}`), enabled: Boolean(id) });
}

export function useSeriesOccurrences(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ["series-occurrences", id],
    queryFn: () => api.get<{ items: OccurrenceDTO[] }>(`/api/series/${id}/occurrences`),
    enabled: Boolean(id) && enabled,
  });
}

export function useSeriesAudit(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["series-audit", id],
    queryFn: () => api.get<{ items: AuditEntryDTO[] }>(`/api/series/${id}/audit`),
    enabled: Boolean(id) && enabled,
  });
}

export function useAttendees(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["attendees", id],
    queryFn: () => api.get<{ attendees: AttendeeDTO[] }>(`/api/occurrences/${id}/attendees`),
    enabled: Boolean(id) && enabled,
    refetchInterval: POLL_MS,
  });
}

export function useClubs() {
  return useQuery({ queryKey: ["clubs"], queryFn: () => api.get<{ items: ClubSummaryDTO[] }>("/api/clubs"), staleTime: 30_000 });
}

export interface ClubDetail extends ClubSummaryDTO {
  organizers: { id: string; displayName: string }[];
  canManage: boolean;
}

export function useClub(idOrSlug: string | undefined) {
  return useQuery({ queryKey: ["club", idOrSlug], queryFn: () => api.get<ClubDetail>(`/api/clubs/${idOrSlug}`), enabled: Boolean(idOrSlug) });
}

export function useClubMembers(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["club-members", id],
    queryFn: () => api.get<{ items: ClubMemberDTO[] }>(`/api/clubs/${id}/members`),
    enabled: Boolean(id) && enabled,
  });
}

export function useRooms() {
  return useQuery({ queryKey: ["rooms"], queryFn: () => api.get<{ items: RoomDTO[] }>("/api/rooms"), staleTime: 60_000 });
}

export function useCategories() {
  return useQuery({ queryKey: ["categories"], queryFn: () => api.get<{ categories: string[] }>("/api/categories"), staleTime: 60_000 });
}

export function useUnreadCount(enabled: boolean) {
  return useQuery({
    queryKey: ["unread"],
    queryFn: () => api.get<{ count: number; serverTime: string }>("/api/notifications/unread-count"),
    refetchInterval: POLL_MS,
    enabled,
    retry: 1,
  });
}

export function useNotifications() {
  return useQuery({
    queryKey: ["notifications"],
    queryFn: () => api.get<{ items: NotificationDTO[]; nextBefore: string | null }>("/api/notifications?limit=50"),
    refetchInterval: POLL_MS,
  });
}

export interface ManagedSeries {
  seriesId: string;
  title: string;
  status: string;
  version: number;
  reviewComment: string | null;
  isRecurring: boolean;
  updatedAt: string;
  club: { id: string; name: string; color: string };
  firstOccurrenceId: string | null;
  firstStartsAt: string | null;
}

export function useManagedSeries(status?: string) {
  return useQuery({
    queryKey: ["managed-series", status],
    queryFn: () => api.get<{ items: ManagedSeries[] }>(`/api/manage/series${qs({ status })}`),
    refetchInterval: POLL_MS,
  });
}

export interface ApprovalItem {
  seriesId: string;
  title: string;
  clubName: string;
  clubColor: string;
  organizerName: string;
  submittedAt: string | null;
  version: number;
  hasRoom: boolean;
  isRecurring: boolean;
  isResubmission: boolean;
  firstOccurrenceId: string | null;
  firstStartsAt: string | null;
}

export function useApprovals(enabled: boolean) {
  return useQuery({
    queryKey: ["approvals"],
    queryFn: () => api.get<{ items: ApprovalItem[] }>("/api/approvals"),
    refetchInterval: POLL_MS,
    enabled,
  });
}

export function useUsers(q: string) {
  return useQuery({
    queryKey: ["users", q],
    queryFn: () => api.get<{ items: UserSummaryDTO[] }>(`/api/admin/users${qs({ q, limit: 100 })}`),
    placeholderData: keepPreviousData,
  });
}

export function useAudit(entityType?: string) {
  return useQuery({
    queryKey: ["audit", entityType],
    queryFn: () => api.get<{ items: AuditEntryDTO[] }>(`/api/admin/audit${qs({ entityType, limit: 100 })}`),
    refetchInterval: POLL_MS,
  });
}

export function useJobHealth() {
  return useQuery({ queryKey: ["jobs"], queryFn: () => api.get<JobHealthDTO>("/api/admin/jobs"), refetchInterval: POLL_MS });
}

export function useAvailability() {
  return useQuery({
    queryKey: ["availability"],
    queryFn: () => api.get<{ windows: { weekday: number; start: string; end: string }[] }>("/api/me/availability"),
  });
}

/** Invalidates every query that shows event state. */
export function useRefreshEvents() {
  const qc = useQueryClient();
  return () =>
    Promise.all(
      ["occurrences", "occurrence", "series", "series-occurrences", "series-audit", "attendees", "managed-series", "approvals", "unread", "notifications"].map((k) =>
        qc.invalidateQueries({ queryKey: [k] }),
      ),
    );
}

export function useRsvp(occurrenceId: string) {
  const refresh = useRefreshEvents();
  return useMutation({
    mutationFn: (response: "going" | "not_going") =>
      api.put<{ status: RsvpStatus; waitlistPosition: number | null; changed: boolean }>(`/api/occurrences/${occurrenceId}/rsvp`, { response }),
    onSettled: () => refresh(),
  });
}

export type { FindTimesResultDTO };
