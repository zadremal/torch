// "Tool call" view: details, error message, input, output and the file link.
import type { ToolCallPanel } from "@contracts/api.ts";
import { Mono } from "../../../atoms/Mono.tsx";
import { Section } from "../../../molecules/Section.tsx";
import { toolFields, toolNotice, toolOutputTitle, toolStatusTag } from "../model.ts";
import { BodyBlock, Fields, LinkButton, Notice, PanelHead, type ViewContext } from "../parts.tsx";

export function ToolCallView({ call, ctx }: { call: ToolCallPanel; ctx: ViewContext }) {
  const notice = toolNotice(call);
  const { filePath } = call;

  return (
    <>
      <PanelHead caption="Tool call" title={call.name} titleKind="mono" tags={[toolStatusTag(call.status)]}>
        {call.target && (
          <Mono size="md" tone="secondary" truncate title={call.target}>
            {call.target}
          </Mono>
        )}
      </PanelHead>

      <Section id="panel-basic" title="Basic information">
        <Fields fields={toolFields(call, ctx.sessionStart)} onOpen={ctx.onOpen} />
      </Section>

      {notice && <Notice notice={notice} />}

      <Section id="panel-input" title="Input">
        <BodyBlock body={call.input} emptyText="No input recorded." onLoadContent={ctx.onLoadContent} />
      </Section>

      <Section id="panel-output" title={toolOutputTitle(call)}>
        <BodyBlock
          body={call.output}
          emptyText="No output recorded."
          error={call.status === "error"}
          onLoadContent={ctx.onLoadContent}
        />
      </Section>

      {filePath && (
        <Section id="panel-file" title="File">
          <div className="torch-panel__path">
            <LinkButton onClick={() => ctx.onOpen({ kind: "file", id: filePath })}>
              <Mono size="md">{filePath}</Mono>
            </LinkButton>
          </div>
        </Section>
      )}
    </>
  );
}
