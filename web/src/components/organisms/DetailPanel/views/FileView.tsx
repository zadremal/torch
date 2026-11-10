// "File" view: operation counters and the list of calls that worked with the file.
import type { FilePanel } from "@contracts/api.ts";
import { fileFields, fileOpRows } from "../model.ts";
import { CallList, FieldsBlock, PanelHead, type ViewContext } from "../parts.tsx";
import styles from "../DetailPanel.module.css";

export function FileView({ file, ctx }: { file: FilePanel; ctx: ViewContext }) {
  return (
    <>
      <PanelHead caption="File" title={file.path} titleKind="path" />
      <FieldsBlock fields={fileFields(file)} onOpen={ctx.onOpen} />
      <section aria-labelledby="panel-operations" className={styles.listBlock}>
        <div className={styles.listHead}>
          <h2 id="panel-operations" className={styles.listTitle}>
            Operations
          </h2>
        </div>
        <CallList
          rows={fileOpRows(file.ops, ctx.sessionStart)}
          onSelect={(id) => ctx.onOpen({ kind: "tool", id })}
          emptyText="No operations recorded for this file."
        />
      </section>
    </>
  );
}
