import { AlertTriangle, CheckCircle2, Loader2, X } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
} from "react";
import type { EventStatus } from "@clubcal/shared";
import { ApiError, errorMessage } from "../api/client";

type Variant = "primary" | "secondary" | "danger" | "ghost";

export function Button({
  variant = "secondary",
  busy,
  children,
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; busy?: boolean }) {
  return (
    <button {...rest} className={`btn btn-${variant} ${className}`} disabled={rest.disabled || busy} aria-busy={busy || undefined}>
      {busy && <Loader2 className="spin" size={16} aria-hidden />}
      {children}
    </button>
  );
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <Loader2 className="spin" size={22} aria-hidden />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state empty">
      <strong>{title}</strong>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const notFound = error instanceof ApiError && error.status === 404;
  return (
    <div className="state error" role="alert">
      <AlertTriangle size={20} aria-hidden />
      <div>
        <strong>{notFound ? "Not found" : "Couldn't load this"}</strong>
        <div className="muted">{notFound ? "It may have been removed, or you may not have access." : errorMessage(error)}</div>
      </div>
      {onRetry && !notFound && (
        <Button onClick={onRetry} variant="secondary">
          Try again
        </Button>
      )}
    </div>
  );
}

export function Alert({ kind = "error", children }: { kind?: "error" | "info" | "success" | "warning"; children: ReactNode }) {
  return (
    <div className={`alert alert-${kind}`} role={kind === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

export function ApiErrorAlert({ error }: { error: unknown }) {
  if (!error) return null;
  const conflicts = error instanceof ApiError ? error.conflicts : [];
  return (
    <Alert kind="error">
      <strong>{errorMessage(error)}</strong>
      {conflicts.length > 0 && (
        <ul className="conflicts">
          {conflicts.map((c, i) => (
            <li key={i}>
              <span className="mono">{c.date}</span> — {c.message}
            </li>
          ))}
        </ul>
      )}
    </Alert>
  );
}

const STATUS_LABEL: Record<EventStatus, string> = {
  draft: "Draft",
  pending: "Awaiting approval",
  approved: "Published",
  rejected: "Changes requested",
  cancelled: "Cancelled",
};

export function StatusBadge({ status }: { status: EventStatus | string }) {
  return <span className={`badge status-${status}`}>{STATUS_LABEL[status as EventStatus] ?? status}</span>;
}

export function ClubBadge({ name, color }: { name: string; color: string }) {
  return (
    <span className="club-badge">
      <span className="dot" style={{ background: color }} aria-hidden />
      {name}
    </span>
  );
}

export function Field({
  label,
  error,
  hint,
  children,
  id: givenId,
}: {
  label: string;
  error?: string[] | string;
  hint?: ReactNode;
  children: (props: { id: string; "aria-invalid"?: boolean; "aria-describedby"?: string }) => ReactNode;
  id?: string;
}) {
  const auto = useId();
  const id = givenId ?? auto;
  const errs = Array.isArray(error) ? error : error ? [error] : [];
  const describedBy = [hint ? `${id}-hint` : null, errs.length ? `${id}-err` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`field ${errs.length ? "has-error" : ""}`}>
      <label htmlFor={id}>{label}</label>
      {children({ id, "aria-invalid": errs.length ? true : undefined, "aria-describedby": describedBy })}
      {hint && (
        <div className="hint" id={`${id}-hint`}>
          {hint}
        </div>
      )}
      {errs.length > 0 && (
        <div className="field-error" id={`${id}-err`}>
          {errs.join(" ")}
        </div>
      )}
    </div>
  );
}

export function Modal({ title, open, onClose, children }: { title: string; open: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      if (typeof d.showModal === "function") d.showModal();
      else d.setAttribute("open", "");
    }
    if (!open && d.open) {
      if (typeof d.close === "function") d.close();
      else d.removeAttribute("open");
    }
  }, [open]);
  return (
    <dialog ref={ref} className="modal" aria-labelledby={titleId} onClose={onClose} onCancel={onClose}>
      {open && (
        <div className="modal-body">
          <div className="modal-head">
            <h2 id={titleId}>{title}</h2>
            <button className="icon-btn" onClick={onClose} aria-label="Close dialog">
              <X size={18} />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
  busy,
  danger = true,
  children,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  busy?: boolean;
  danger?: boolean;
  children?: ReactNode;
}) {
  return (
    <Modal title={title} open={open} onClose={onClose}>
      <div className="stack">
        <div>{body}</div>
        {children}
        <div className="row end">
          <Button onClick={onClose} disabled={busy}>
            Keep it
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onConfirm} busy={busy} autoFocus>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

interface Toast {
  id: number;
  text: string;
  kind: "success" | "error";
}
const ToastCtx = createContext<(text: string, kind?: Toast["kind"]) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast["kind"] = "success") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite" role="status">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.kind === "success" ? <CheckCircle2 size={16} aria-hidden /> : <AlertTriangle size={16} aria-hidden />}
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

export function DemoBadge() {
  return (
    <span className="badge demo" title="Synthetic data created by the demo seed">
      Demo data
    </span>
  );
}

export function PageHeader({ title, children, subtitle }: { title: string; subtitle?: ReactNode; children?: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · ClubCal`;
  }, [title]);
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {children && <div className="row wrap">{children}</div>}
    </div>
  );
}
