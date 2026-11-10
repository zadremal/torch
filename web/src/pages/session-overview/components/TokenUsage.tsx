// The Token usage block: a composite bar (the ProportionChart organism) and four token-kind cards.
import type { TokenTotals } from "@contracts/api.ts";
import { ProportionChart } from "../../../components/organisms/ProportionChart/ProportionChart.tsx";
import { tokenCards } from "../model.ts";
import styles from "./TokenUsage.module.css";

export function TokenUsage({ tokens }: { tokens: TokenTotals }) {
  return (
    <>
      <ProportionChart kind="tokens" label="Token usage" tokens={tokens} />
      <div className={styles.cards}>
        {tokenCards(tokens).map((card) => (
          <div key={card.label} className={styles.card} style={{ borderBlockStartColor: card.color }}>
            <span className={styles.label}>{card.label}</span>
            <span className={styles.value}>{card.value}</span>
            <span className={styles.note}>{card.note}</span>
          </div>
        ))}
      </div>
    </>
  );
}
