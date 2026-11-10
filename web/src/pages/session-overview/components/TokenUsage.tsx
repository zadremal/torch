// The Token usage block: a composite bar (the ProportionChart organism) and four token-kind cards.
import type { TokenTotals } from "@contracts/api.ts";
import { ProportionChart } from "../../../components/organisms/ProportionChart/ProportionChart.tsx";
import { tokenCards } from "../model.ts";
import "./TokenUsage.scss";

export function TokenUsage({ tokens }: { tokens: TokenTotals }) {
  return (
    <>
      <ProportionChart kind="tokens" label="Token usage" tokens={tokens} />
      <div className="torch-session-token-cards">
        {tokenCards(tokens).map((card) => (
          <div key={card.label} className="torch-session-token-card" style={{ borderBlockStartColor: card.color }}>
            <span className="torch-session-token-card__label">{card.label}</span>
            <span className="torch-session-token-card__value">{card.value}</span>
            <span className="torch-session-token-card__note">{card.note}</span>
          </div>
        ))}
      </div>
    </>
  );
}
