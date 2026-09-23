import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { api } from "../lib/api";
import { useServiceWorkerUpdate } from "../lib/pwa";

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
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  useEffect(() => {
    if (location.pathname) setMenuOpen(false);
  }, [location.pathname]);
  const session = useQuery({
    queryKey: ["session"],
    queryFn: () => api.get<Session>("/api/session"),
    staleTime: 5 * 60 * 1000,
  });
  const update = useServiceWorkerUpdate();

  return (
    <div className="flex min-h-full flex-col lg:flex-row">
      {update.updateReady ? (
        <div role="status" className="admin-update-banner">
          <span>管理画面の新しいバージョンがあります。</span>
          <button type="button" onClick={update.reload}>
            再読み込み
          </button>
        </div>
      ) : null}
      <nav aria-label="メインナビゲーション" className="admin-nav">
        <div className="admin-nav-header">
          <p className="text-sm font-medium tracking-tight text-ink">
            Tomokichi Studio <span className="text-ink-soft">Admin</span>
          </p>
          <button
            type="button"
            className="admin-menu-toggle"
            aria-expanded={menuOpen}
            aria-controls="admin-menu"
            onClick={() => setMenuOpen(!menuOpen)}
          >
            {menuOpen ? "閉じる" : "メニュー"}
          </button>
        </div>
        <div className="admin-mobile-links">
          <NavLink to="/" end>
            ホーム
          </NavLink>
          <NavLink to="/tickets">チケット</NavLink>
          <NavLink to="/reports">通報</NavLink>
        </div>

        <div id="admin-menu" className={`admin-menu ${menuOpen ? "is-open" : ""}`}>
          <Group>
            <Item to="/" end>
              ダッシュボード
            </Item>
          </Group>
          <Group label="運用">
            <Item to="/tickets" end>
              チケット
            </Item>
            <Item to="/reports">通報</Item>
            <Item to="/incidents">障害</Item>
            <Item to="/support" end>
              問い合わせ
            </Item>
            <Item to="/support/templates">返信定型文</Item>
            <Item to="/tickets/settings">運用設定</Item>
            <Item to="/settings/notifications">通知設定</Item>
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
          `block rounded-md px-3 py-3 text-sm transition-colors ${
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
