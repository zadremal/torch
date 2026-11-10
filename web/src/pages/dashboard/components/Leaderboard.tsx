// A top of sessions by one metric, as in the artboard's Insights block: rank, name linking to the session
// overview, short identifier with the project, and the value. The rows are prepared by model.ts.
import { Link } from "react-router";
import { Mono } from "../../../components/atoms/Mono.tsx";
import type { LeaderboardRow } from "../model.ts";
import "./Leaderboard.scss";

export interface LeaderboardProps {
  title: string;
  /** What the value measures: "Cost", "Duration". */
  metric: string;
  rows: readonly LeaderboardRow[];
}

export function Leaderboard({ title, metric, rows }: LeaderboardProps) {
  return (
    <div className="torch-leaderboard">
      <div className="torch-leaderboard__head">
        <h3 className="torch-leaderboard__title">{title}</h3>
        <span className="torch-leaderboard__metric">{metric}</span>
      </div>
      {rows.length === 0 ? (
        <p className="torch-leaderboard__empty">No sessions in this period</p>
      ) : (
        <ol className="torch-leaderboard__list">
          {rows.map((row) => (
            <li key={row.href} className="torch-leaderboard__item">
              <span className="torch-leaderboard__rank">{row.rank}</span>
              <span className="torch-leaderboard__session">
                <Link className="torch-leaderboard__link" to={row.href} title={row.name}>
                  {row.name}
                </Link>
                <Mono tone="helper" truncate>
                  {row.meta}
                </Mono>
              </span>
              <span className="torch-leaderboard__value">{row.value}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
