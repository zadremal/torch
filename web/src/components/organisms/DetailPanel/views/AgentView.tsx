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

export function AgentView({ agent, ctx }: { agent: AgentPanel; ctx: ViewContext }) {
  const [errorsOnly, setErrorsOnly] = useState(false);
  const description = agentDescription(agent);
  const instructions = instructionRows(agent.instructions);
  const shown = visibleCalls(agent.calls, errorsOnly);
  const peakCallId = agent.ctxPeakCallId;

  return (
    <>
      <PanelHead caption="Agent" title={agentName(agent.agentId, agent.type)} tags={agentTags(agent)}>
        {description && <p className="torch-panel__description">{description}</p>}
      </PanelHead>

      <Section id="panel-basic" title="Basic information">
        <Fields fields={agentFields(agent)} onOpen={ctx.onOpen} />
      </Section>

      <Section id="panel-prompt" title="Input prompt">
        <BodyBlock body={agent.prompt} emptyText="No prompt recorded." onLoadContent={ctx.onLoadContent} />
      </Section>

      <Section id="panel-context" title="Context" aside={contextWindowAside(agent)}>
        <div className="torch-panel__rows">
          {contextStages(agent).map((stage) => (
            <div key={stage.label} className="torch-panel__stage">
              <span className="torch-panel__stage-label">{stage.label}</span>
              <Meter ratio={stage.ratio} color={stage.color} />
              <span className="torch-panel__number">{stage.value}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section id="panel-peak" title="What was in the context at peak" aside={breakdownAside(agent)}>
        <ProportionChart kind="context" label="Context at peak" breakdown={agent.ctxBreakdown} />
        {peakCallId && (
          <div>
            <LinkButton onClick={() => ctx.onOpen({ kind: "net", net: "model", id: peakCallId })}>
              Open the peak model call
            </LinkButton>
          </div>
        )}
      </Section>

      <Section id="panel-instructions" title="Instructions loaded">
        {instructions.length === 0 ? (
          <p className="torch-panel__empty">No instructions recorded for this agent.</p>
        ) : (
          <div className="torch-panel__instructions">
            {instructions.map((row, index) => (
              <div key={`${row.path}:${index}`} className="torch-panel__instruction">
                <Mono size="md" truncate title={row.path}>
                  {row.path}
                </Mono>
                <span className="torch-panel__instruction-tokens">{row.tokens}</span>
                <span className="torch-panel__instruction-kind">{row.kind}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section id="panel-usage" title="Tool usage" aside={toolUsageAside(agent)}>
        <div className="torch-panel__rows">
          {toolUsageRows(agent.toolUsage).map((row) => (
            <div key={row.name} className="torch-panel__usage">
              <Mono size="md" truncate title={row.name}>
                {row.name}
              </Mono>
              <Meter ratio={row.ratio} color={TOOL_USAGE_COLOR} track={false} />
              <span className="torch-panel__number">
                {row.count}
                {row.errors > 0 && (
                  <span className="torch-panel__usage-errors" title={`${row.errors} failed`}>
                    {" "}
                    · {row.errors}✕
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      </Section>

      <section aria-labelledby="panel-calls" className="torch-panel__list-block">
        <div className="torch-panel__list-head">
          <h2 id="panel-calls" className="torch-panel__list-title">
            Tool calls <span className="torch-panel__count">({shown.length})</span>
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
