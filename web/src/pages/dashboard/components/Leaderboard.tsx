// A top of sessions by one metric, as in the artboard's Insights block: rank, name linking to the session
// overview, short identifier with the project, and the value. The rows are prepared by model.ts.
import { Link } from "react-router";
import { Mono } from "../../../components/atoms/Mono.tsx";
import type { LeaderboardRow } from "../model.ts";
import styles from "./Leaderboard.module.css";

export interface LeaderboardProps {
  title: string;
  /** What the value measures: "Cost", "Duration". */
  metric: string;
  rows: readonly LeaderboardRow[];
}

export function Leaderboard({ title, metric, rows }: LeaderboardProps) {
  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <h3 className={styles.title}>{title}</h3>
        <span className={styles.metric}>{metric}</span>
      </div>
      {rows.length === 0 ? (
        <p className={styles.empty}>No sessions in this period</p>
      ) : (
        <ol className={styles.list}>
          {rows.map((row) => (
            <li key={row.href} className={styles.item}>
              <span className={styles.rank}>{row.rank}</span>
              <span className={styles.session}>
                <Link className={styles.link} to={row.href} title={row.name}>
                  {row.name}
                </Link>
                <Mono tone="helper" truncate>
                  {row.meta}
                </Mono>
              </span>
              <span className={styles.value}>{row.value}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
