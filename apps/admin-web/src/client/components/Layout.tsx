import { useQuery } from "@tanstack/react-query";
import { NavLink, Outlet } from "react-router";
import { api } from "../lib/api";

interface Session {
  email?: string;
  role: string;
  mailConfigured: boolean;
}

/**
 * The frame.
 *
 * Three groups, in the order somebody actually uses them: what needs attention,
 * what is being operated, and the Studio itself. Nothing here is a placeholder
 * link to a 404 — every entry goes to a screen that exists.
 */
export function Layout() {
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () => api.get<Session>("/api/session"),
    staleTime: 5 * 60 * 1000,
  });

  return (
    <div className="flex min-h-full flex-col lg:flex-row">
      <nav
        aria-label="メインナビゲーション"
        className="shrink-0 border-b border-line bg-surface px-6 py-5 lg:w-56 lg:border-r lg:border-b-0 lg:px-5 lg:py-8"
      >
        <p className="text-sm font-medium tracking-tight text-ink">Tomokichi Studio</p>
        <p className="mt-0.5 text-xs text-ink-faint">Admin</p>

        <div className="mt-7 flex flex-wrap gap-x-6 gap-y-5 lg:block lg:space-y-6">
          <Group>
            <Item to="/" end>
              ダッシュボード
            </Item>
          </Group>
          <Group label="運用">
            <Item to="/reports">通報</Item>
            <Item to="/support">問い合わせ</Item>
            <Item to="/support/templates">返信定型文</Item>
          </Group>
          <Group label="スタジオ">
            <Item to="/apps">アプリ</Item>
          </Group>
        </div>

        <div className="mt-8 hidden text-xs text-ink-faint lg:block">
          {session.data?.email ? <p className="truncate">{session.data.email}</p> : null}
          {session.data && !session.data.mailConfigured ? (
            <p className="mt-2 text-warn">メール送信 未設定</p>
          ) : null}
        </div>
      </nav>

      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}

function Group({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div>
      {label ? (
        <p className="mb-2 text-[0.65rem] font-medium tracking-wider text-ink-faint">{label}</p>
      ) : null}
      <ul className="space-y-1">{children}</ul>
    </div>
  );
}

function Item({ to, end, children }: { to: string; end?: boolean; children: React.ReactNode }) {
  return (
    <li>
      <NavLink
        to={to}
        end={end}
        className={({ isActive }) =>
          `block rounded-md px-2 py-1 text-sm transition-colors ${
            isActive
              ? "bg-accent-soft text-accent"
              : "text-ink-soft hover:bg-line-soft hover:text-ink"
          }`
        }
      >
        {children}
      </NavLink>
    </li>
  );
}
