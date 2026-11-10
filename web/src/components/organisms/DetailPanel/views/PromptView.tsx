// "User prompt" view: when it was sent, token estimate, attachments and text.
import type { PromptPanel } from "@contracts/api.ts";
import { Section } from "../../../molecules/Section.tsx";
import { promptFields, promptTitle } from "../model.ts";
import { BodyBlock, FieldsBlock, PanelHead, type ViewContext } from "../parts.tsx";

export function PromptView({ prompt, ctx }: { prompt: PromptPanel; ctx: ViewContext }) {
  return (
    <>
      <PanelHead caption="User prompt" title={promptTitle(prompt.kind)} />
      <FieldsBlock fields={promptFields(prompt, ctx.sessionStart)} onOpen={ctx.onOpen} />
      <Section variant="panel" id="panel-prompt" title="Prompt">
        <BodyBlock body={prompt.body} emptyText="No prompt recorded." large onLoadContent={ctx.onLoadContent} />
      </Section>
    </>
  );
}
