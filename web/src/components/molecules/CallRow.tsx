// Molecule: a button row for a tool call in the detail panel lists — Tool calls of an agent
// and Operations of a file. All values arrive as ready strings: the molecule knows nothing about API types.
import { ErrorFilled } from "@carbon/icons-react";
import { Mono } from "../atoms/Mono.tsx";
import "./CallRow.scss";

export interface CallRowProps {
  /** Time since the session start: "+6:12". */
  time: string;
  /** Tool name. */
  name: string;
  /** Third column: the call target (command, path) or the agent name in a file's operations list. */
  detail: string;
  /** false — the `detail` column in a regular font: an agent name, not a path or command. */
  detailMono?: boolean;
  /** Already formatted duration. */
  duration: string;
  error?: boolean;
  /** The row currently open in the panel. */
  current?: boolean;
  onSelect: () => void;
}

export function CallRow({
  time,
  name,
  detail,
  detailMono = true,
  duration,
  error = false,
  current = false,
  onSelect,
}: CallRowProps) {
  const className = ["torch-call-row", error && "torch-call-row--error", current && "torch-call-row--current"]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      className={className}
      aria-label={`${name} ${detail}${error ? ", failed" : ""}`}
      aria-current={current || undefined}
      onClick={onSelect}
    >
      <span className="torch-call-row__time">
        <Mono>{time}</Mono>
      </span>
      <span className="torch-call-row__name">
        <Mono size="md">{name}</Mono>
      </span>
      {detailMono ? (
        <Mono truncate title={detail}>
          {detail}
        </Mono>
      ) : (
        <span className="torch-call-row__detail" title={detail}>
          {detail}
        </span>
      )}
      <span className="torch-call-row__duration">
        <Mono>{duration}</Mono>
      </span>
      {error && <ErrorFilled size={16} className="torch-call-row__icon" aria-hidden="true" />}
    </button>
  );
}
