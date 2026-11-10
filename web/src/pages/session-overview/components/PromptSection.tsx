// The Original prompt block: the original prompt text and an expandable list of follow-ups.
// The caption ("Sent …") is rendered by the block heading, see Section.
import { Mono } from "../../../components/atoms/Mono.tsx";
import { formatClock } from "../../../lib/format.ts";
import type { PromptsModel } from "../model.ts";
import "./PromptSection.scss";

export function PromptSection({ model }: { model: PromptsModel }) {
  return (
    <>
      <div className="torch-session-prompt__text">{model.original.text}</div>
      {model.followUps.length > 0 && (
        <details className="torch-session-prompt__more">
          <summary>{model.followUpsLabel}</summary>
          <ol>
            {model.followUps.map((p) => (
              <li key={p.id}>
                <Mono tone="helper">{formatClock(p.ts)}</Mono> — {p.text}
              </li>
            ))}
          </ol>
        </details>
      )}
    </>
  );
}
