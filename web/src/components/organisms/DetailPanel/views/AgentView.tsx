// "Agent" view: details, input prompt, context, instructions, tools and the call list.
import { Checkbox } from "@carbon/react";
import type { AgentPanel } from "@contracts/api.ts";
import { useState } from "react";
import { TOOL_USAGE_COLOR } from "../../../../styles/palette.ts";
import { Meter } from "../../../atoms/Meter.tsx";
import { Mono } from "../../../atoms/Mono.tsx";
import { Section } from "../../../molecules/Section.tsx";
import { ProportionChart } from "../../ProportionChart/ProportionChart.tsx";
import {
  agentDescription,
  agentFields,
  agentName,
  agentTags,
  breakdownAside,
  callRows,
  contextStages,
  contextWindowAside,
  emptyCallsText,
  failedCount,
  instructionRows,
  toolUsageAside,
  toolUsageRows,
  visibleCalls,
} from "../model.ts";
import { BodyBlock, CallList, Fields, LinkButton, PanelHead, type ViewContext } from "../parts.tsx";
import styles from "../DetailPanel.module.css";

export function AgentView({ agent, ctx }: { agent: AgentPanel; ctx: ViewContext }) {
  const [errorsOnly, setErrorsOnly] = useState(false);
  const description = agentDescription(agent);
  const instructions = instructionRows(agent.instructions);
  const shown = visibleCalls(agent.calls, errorsOnly);
  const peakCallId = agent.ctxPeakCallId;

  return (
    <>
      <PanelHead caption="Agent" title={agentName(agent.agentId, agent.type)} tags={agentTags(agent)}>
        {description && <p className={styles.description}>{description}</p>}
      </PanelHead>

      <Section variant="panel" id="panel-basic" title="Basic information">
        <Fields fields={agentFields(agent)} onOpen={ctx.onOpen} />
      </Section>

      <Section variant="panel" id="panel-prompt" title="Input prompt">
        <BodyBlock body={agent.prompt} emptyText="No prompt recorded." onLoadContent={ctx.onLoadContent} />
      </Section>

      <Section variant="panel" id="panel-context" title="Context" aside={contextWindowAside(agent)}>
        <div className={styles.rows}>
          {contextStages(agent).map((stage) => (
            <div key={stage.label} className={styles.stage}>
              <span className={styles.stageLabel}>{stage.label}</span>
              <Meter ratio={stage.ratio} color={stage.color} />
              <span className={styles.number}>{stage.value}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section variant="panel" id="panel-peak" title="What was in the context at peak" aside={breakdownAside(agent)}>
        <ProportionChart kind="context" label="Context at peak" breakdown={agent.ctxBreakdown} />
        {peakCallId && (
          <div>
            <LinkButton onClick={() => ctx.onOpen({ kind: "net", net: "model", id: peakCallId })}>
              Open the peak model call
            </LinkButton>
          </div>
        )}
      </Section>

      <Section variant="panel" id="panel-instructions" title="Instructions loaded">
        {instructions.length === 0 ? (
          <p className={styles.empty}>No instructions recorded for this agent.</p>
        ) : (
          <div className={styles.instructions}>
            {instructions.map((row, index) => (
              <div key={`${row.path}:${index}`} className={styles.instruction}>
                <Mono size="md" truncate title={row.path}>
                  {row.path}
                </Mono>
                <span className={styles.instructionTokens}>{row.tokens}</span>
                <span className={styles.instructionKind}>{row.kind}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section variant="panel" id="panel-usage" title="Tool usage" aside={toolUsageAside(agent)}>
        <div className={styles.rows}>
          {toolUsageRows(agent.toolUsage).map((row) => (
            <div key={row.name} className={styles.usage}>
              <Mono size="md" truncate title={row.name}>
                {row.name}
              </Mono>
              <Meter ratio={row.ratio} color={TOOL_USAGE_COLOR} track={false} />
              <span className={styles.number}>
                {row.count}
                {row.errors > 0 && (
                  <span className={styles.usageErrors} title={`${row.errors} failed`}>
                    {" "}
                    · {row.errors}✕
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      </Section>

      <section aria-labelledby="panel-calls" className={styles.listBlock}>
        <div className={styles.listHead}>
          <h2 id="panel-calls" className={styles.listTitle}>
            Tool calls <span className={styles.count}>({shown.length})</span>
          </h2>
          <Checkbox
            id="panel-errors-only"
            labelText={`Errors only (${failedCount(agent.calls)})`}
            checked={errorsOnly}
            onChange={(_event, { checked }) => setErrorsOnly(checked)}
          />
        </div>
        <CallList
          rows={callRows(shown, ctx.sessionStart)}
          onSelect={(id) => ctx.onOpen({ kind: "tool", id })}
          emptyText={emptyCallsText(errorsOnly)}
        />
      </section>
    </>
  );
}
