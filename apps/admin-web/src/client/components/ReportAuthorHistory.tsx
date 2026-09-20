import type { ReportDetail } from "@tomokichi/admin-contracts";
import { Link } from "react-router";
import { Timestamp } from "./primitives";

export function ReportAuthorHistory({ report }: { report: ReportDetail }) {
  const history = report.authorHistory;
  return (
    <div className="my-4 rounded-lg border border-line p-3 text-sm">
      <p className="font-medium">投稿者</p>
      {report.authorRefHash ? (
        <>
          <p className="mt-1 font-mono text-xs break-all" title={report.authorRefHash}>
            ID: {report.authorRefHash.slice(0, 16)}
          </p>
          {history && (
            <>
              <div className="my-3 flex flex-wrap gap-x-5 gap-y-2">
                <span>
                  通報 <strong>{history.total}件</strong>
                </span>
                <span>
                  通報者 <strong>{history.uniqueReporters} ID</strong>
                </span>
                <span>
                  対応あり <strong>{history.actioned}件</strong>
                </span>
              </div>
              <details>
                <summary className="cursor-pointer text-accent">
                  同じ投稿者への通報（直近10件）
                </summary>
                <ul className="mt-2 divide-y divide-line">
                  {history.recent.map((item) => (
                    <li key={item.id} className="py-2">
                      <Link className="text-accent block" to={`/reports/${item.id}`}>
                        <Timestamp value={item.createdAt} /> · {item.reasonCode}
                        {item.id === report.id ? "（この通報）" : ""}
                      </Link>
                    </li>
                  ))}
                </ul>
              </details>
            </>
          )}
          <p className="mt-2 text-xs text-ink-soft">
            アプリが申告したIDで集計。通報件数は違反確定件数ではありません。
          </p>
        </>
      ) : (
        <p className="mt-1 text-ink-soft">不明（投稿者IDの記録なし）</p>
      )}
    </div>
  );
}
