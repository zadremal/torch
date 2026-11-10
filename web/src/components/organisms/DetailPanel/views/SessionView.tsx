// "Session" view: session totals and links to its agents. Data is the session overview response.
import type { SessionOverview } from "@contracts/api.ts";
import { Section } from "../../../molecules/Section.tsx";
import { sessionAgentLinks, sessionFields, sessionTags } from "../model.ts";
import { FieldsBlock, LinkButton, PanelHead, type ViewContext } from "../parts.tsx";

export function SessionView({ session, ctx }: { session: SessionOverview; ctx: ViewContext }) {
  return (
    <>
      <PanelHead caption="Session" title={session.name} tags={sessionTags(session)} />
      <FieldsBlock fields={sessionFields(session)} onOpen={ctx.onOpen} />
      <Section id="panel-agents" title="Agents">
        <ul className="torch-panel__agents">
          {sessionAgentLinks(session).map((agent) => (
            // Nested subagents — indented by depth (plan §9.3).
            <li key={agent.agentId} style={{ paddingInlineStart: `calc(${agent.depth} * 1rem)` }}>
              <LinkButton onClick={() => ctx.onOpen({ kind: "agent", id: agent.agentId })}>{agent.label}</LinkButton>
              {agent.description && <span className="torch-panel__agent-note"> — {agent.description}</span>}
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
