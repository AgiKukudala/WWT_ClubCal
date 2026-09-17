import { Navigate, Route, Routes } from "react-router-dom";
import { RequireAuth } from "./auth";
import { Layout } from "./components/Layout";
import { AdminPage } from "./pages/AdminPage";
import { CalendarPage } from "./pages/CalendarPage";
import { ClubDetailPage } from "./pages/ClubDetailPage";
import { ClubsPage } from "./pages/ClubsPage";
import { EventDetailPage } from "./pages/EventDetailPage";
import { EventFormPage } from "./pages/EventFormPage";
import { LoginPage, RegisterPage } from "./pages/AuthPages";
import { NotificationsPage } from "./pages/NotificationsPage";
import { OccurrenceEditPage } from "./pages/OccurrenceEditPage";
import { OrganizerPage } from "./pages/OrganizerPage";
import { SchedulePage } from "./pages/SchedulePage";
import { SettingsPage } from "./pages/SettingsPage";

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<CalendarPage />} />
        <Route path="schedule" element={<SchedulePage />} />
        <Route path="clubs" element={<ClubsPage />} />
        <Route path="clubs/:idOrSlug" element={<ClubDetailPage />} />
        <Route path="notifications" element={<NotificationsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="events/new" element={<RequireAuth roles={["organizer", "admin"]}><EventFormPage /></RequireAuth>} />
        <Route path="events/:id" element={<EventDetailPage />} />
        <Route path="series/:seriesId/edit" element={<RequireAuth roles={["organizer", "admin"]}><EventFormPage /></RequireAuth>} />
        <Route path="events/:id/edit" element={<RequireAuth roles={["organizer", "admin"]}><OccurrenceEditPage /></RequireAuth>} />
        <Route path="organizer" element={<RequireAuth roles={["organizer", "admin"]}><OrganizerPage /></RequireAuth>} />
        <Route path="admin/*" element={<RequireAuth roles={["admin"]}><AdminPage /></RequireAuth>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
