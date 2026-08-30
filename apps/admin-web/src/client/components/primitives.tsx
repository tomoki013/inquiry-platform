import type { ReactNode } from "react";
import { statusLabel } from "../lib/labels";

/**
 * The small shared pieces every screen uses.
 *
 * Kept in one file because there are not many and each is a dozen lines — a
 * directory of one-component files would be more navigation than code.
 */

export function Page({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10 sm:px-10">
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-medium tracking-tight text-ink">{title}</h1>
          {description ? <p className="mt-1 text-sm text-ink-soft">{description}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-line bg-surface ${className}`}>{children}</div>;
}

export function Button({
  children,
  onClick,
  type = "button",
  variant = "default",
  disabled,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "default" | "primary" | "quiet";
  disabled?: boolean;
  title?: string;
}) {
  const base =
    "inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-45";
  const styles = {
    default: "border border-line bg-surface text-ink hover:bg-line-soft",
    primary: "bg-accent text-white hover:opacity-90",
    quiet: "text-ink-soft hover:text-ink hover:bg-line-soft",
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`${base} ${styles}`}
    >
      {children}
    </button>
  );
}

/**
 * A status, said in words as well as colour.
 *
 * The label is always present — colour alone would leave the state unreadable
 * to anybody who does not distinguish these hues, and "open" versus "closed" is
 * the single most important thing on the Reports screen.
 */
export function StatusPill({ status }: { status: string }) {
  const tone: Record<string, string> = {
    open: "bg-warn-soft text-warn",
    reviewing: "bg-accent-soft text-accent",
    actioned: "bg-good-soft text-good",
    closed: "bg-line-soft text-ink-soft",
    pending_user: "bg-accent-soft text-accent",
    resolved: "bg-good-soft text-good",
    spam: "bg-danger-soft text-danger",
    live: "bg-good-soft text-good",
    testflight: "bg-accent-soft text-accent",
    development: "bg-line-soft text-ink-soft",
    review: "bg-warn-soft text-warn",
    paused: "bg-warn-soft text-warn",
    retired: "bg-line-soft text-ink-faint",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        tone[status] ?? "bg-line-soft text-ink-soft"
      }`}
    >
      {statusLabel(status)}
    </span>
  );
}

/**
 * Loading, empty and error, for every list on every screen.
 *
 * A table that renders its header and nothing else is the most common way an
 * admin screen lies about the state of the world — it looks like "no reports"
 * whether that is true, still loading, or broken.
 */
export function DataState({
  loading,
  error,
  empty,
  emptyMessage,
  children,
}: {
  loading: boolean;
  error: unknown;
  empty: boolean;
  emptyMessage: string;
  children: ReactNode;
}) {
  if (loading) {
    return (
      <p role="status" className="py-12 text-center text-sm text-ink-faint">
        読み込んでいます…
      </p>
    );
  }
  if (error) {
    const message = error instanceof Error ? error.message : "問題が発生しました。";
    const requestId =
      typeof error === "object" && error && "requestId" in error
        ? (error as { requestId?: string }).requestId
        : undefined;
    return (
      <div
        role="alert"
        className="rounded-lg border border-line bg-danger-soft/50 px-4 py-6 text-sm"
      >
        <p className="text-danger">{message}</p>
        {requestId ? <p className="mt-1 text-xs text-ink-faint">requestId: {requestId}</p> : null}
      </div>
    );
  }
  if (empty) {
    return <p className="py-12 text-center text-sm text-ink-faint">{emptyMessage}</p>;
  }
  return <>{children}</>;
}

/**
 * A labelled control.
 *
 * The label wraps its input rather than pointing at one by id: this screen
 * generates several of these per form, and hand-rolled ids are how a page ends
 * up with two `for="name"` labels that both focus the first field.
 */
export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is `children`.
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-soft">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-ink-faint">{hint}</span> : null}
      {error ? (
        <span role="alert" className="mt-1 block text-xs text-danger">
          {error}
        </span>
      ) : null}
    </label>
  );
}

export const inputClass =
  "w-full rounded-md border border-line bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-ink-faint";

export function Timestamp({ value }: { value: string }) {
  const parsed = new Date(value);
  return (
    <time dateTime={value} title={value} className="tabular-nums">
      {Number.isNaN(parsed.getTime())
        ? value
        : parsed.toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" })}
    </time>
  );
}
