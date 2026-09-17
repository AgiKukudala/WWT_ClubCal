import { useQueryClient } from "@tanstack/react-query";
import { Bell, CalendarDays, ClipboardList, LogOut, Menu, Settings, Shield, Users, UserRoundCheck } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useApprovals, useUnreadCount } from "../api/hooks";
import { isManager, useSignOut, useUser } from "../auth";
import { SyncStatus } from "./SyncStatus";

function Item({ to, icon, children, badge }: { to: string; icon: ReactNode; children: ReactNode; badge?: number }) {
  return (
    <NavLink to={to} end={to === "/"} className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
      {icon}
      <span>{children}</span>
      {badge ? (
        <span className="count" aria-label={`${badge} unread`}>
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </NavLink>
  );
}

export function Layout() {
  const me = useUser();
  const signOut = useSignOut();
  const unread = useUnreadCount(true);
  const approvals = useApprovals(me.role === "admin");
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const [lastSync, setLastSync] = useState<number | null>(null);

  useEffect(() => {
    setOpen(false);
    // Move focus to the main region on navigation for screen reader and keyboard users.
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [location.pathname]);

  useEffect(() => {
    if (unread.dataUpdatedAt) setLastSync(unread.dataUpdatedAt);
  }, [unread.dataUpdatedAt]);

  useEffect(() => {
    // Notification count changed → something happened; refresh event views too.
    if (unread.data) void qc.invalidateQueries({ queryKey: ["occurrences"] });
  }, [unread.data?.count, qc]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <span>ClubCal</span>
        </div>
        <button className="icon-btn menu-toggle" aria-expanded={open} aria-controls="primary-nav" onClick={() => setOpen((o) => !o)} aria-label={unread.data?.count ? `Menu, ${unread.data.count} unread notifications` : "Menu"}>
          <Menu size={20} />
          {unread.data?.count ? <span className="count menu-count" aria-hidden>{unread.data.count > 99 ? "99+" : unread.data.count}</span> : null}
        </button>
        <nav id="primary-nav" className={`nav ${open ? "open" : ""}`} aria-label="Primary">
          <Item to="/" icon={<CalendarDays size={18} aria-hidden />}>
            Calendar
          </Item>
          <Item to="/schedule" icon={<UserRoundCheck size={18} aria-hidden />}>
            My Schedule
          </Item>
          <Item to="/clubs" icon={<Users size={18} aria-hidden />}>
            Clubs
          </Item>
          <Item to="/notifications" icon={<Bell size={18} aria-hidden />} badge={unread.data?.count}>
            Notifications
          </Item>
          {isManager(me) && (
            <Item to="/organizer" icon={<ClipboardList size={18} aria-hidden />}>
              Organizer
            </Item>
          )}
          {me.role === "admin" && (
            <Item to="/admin" icon={<Shield size={18} aria-hidden />} badge={approvals.data?.items.length}>
              Admin
            </Item>
          )}
          <div className="nav-user">
            <NavLink to="/settings" className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
              <Settings size={18} aria-hidden />
              <span className="truncate">{me.displayName}</span>
            </NavLink>
            <button className="nav-link as-button" onClick={() => void signOut()}>
              <LogOut size={18} aria-hidden />
              <span>Sign out</span>
            </button>
          </div>
        </nav>
      </header>
      <div className="subbar">
        <span className="muted small">
          Signed in as <strong>{me.role === "admin" ? "Administrator" : me.role === "organizer" ? "Club organizer" : "Student"}</strong> · times shown in {me.timezone}
        </span>
        <SyncStatus lastSync={lastSync} failing={unread.isError} />
      </div>
      <main id="main" ref={mainRef} tabIndex={-1}>
        <Outlet />
      </main>
      <footer className="footer muted small">
        ClubCal · Calendar export is a one-time .ics download, not live sync. · Original calendar UI by{" "}
        <a href="https://www.youtube.com/channel/UCiUtBDVaSmMGKxg1HYeK-BQ" target="_blank" rel="noreferrer">
          Open Source Coding
        </a>{" "}
        (see legacy/).
      </footer>
    </div>
  );
}
