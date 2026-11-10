// "Network call" view: a model call, its failed attempt or an external request (plan §9.3:
// tokens, latency and stop reason instead of sizes in bytes; status — only for errors).
import type { NetworkPanel } from "@contracts/api.ts";
import { Mono } from "../../../atoms/Mono.tsx";
import { Section } from "../../../molecules/Section.tsx";
import { callRows, messageTitle, networkFields, networkNotice, networkSubject, networkTags } from "../model.ts";
import { BodyBlock, CallList, FieldsBlock, Notice, PanelHead, Pre, type ViewContext } from "../parts.tsx";

export function NetworkView({ call, ctx }: { call: NetworkPanel; ctx: ViewContext }) {
  const subject = networkSubject(call);
  const notice = networkNotice(call);

  return (
    <>
      <PanelHead caption="Network call" tags={networkTags(call)}>
        {subject && (
          <span className="torch-panel__path">
            <Mono size="md">{subject}</Mono>
          </span>
        )}
      </PanelHead>

      {notice && <Notice notice={notice} />}

      <FieldsBlock fields={networkFields(call, ctx.sessionStart)} onOpen={ctx.onOpen} />

      {call.net === "model" &&
        call.messages.map((message, index) => (
          <Section key={message.body.contentId} id={`panel-message-${index}`} title={messageTitle(message.kind)}>
            <BodyBlock body={message.body} emptyText="No text recorded." onLoadContent={ctx.onLoadContent} />
          </Section>
        ))}

      {call.net === "model" && call.toolCalls.length > 0 && (
        <section aria-labelledby="panel-requested" className="torch-panel__list-block">
          <div className="torch-panel__list-head">
            <h2 id="panel-requested" className="torch-panel__list-title">
              Tool calls requested <span className="torch-panel__count">({call.toolCalls.length})</span>
            </h2>
          </div>
          <CallList
            rows={callRows(call.toolCalls, ctx.sessionStart)}
            onSelect={(id) => ctx.onOpen({ kind: "tool", id })}
          />
        </section>
      )}

      {call.net === "error" && (
        <Section id="panel-error" title="Error response">
          <Pre text={call.error} error />
        </Section>
      )}
    </>
  );
}
