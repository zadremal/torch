// Detail panel parts shared by its views: view header, fields, link button, call body,
// call list, error message. Data arrives as ready values from model.ts.
import { CheckmarkFilled, ErrorFilled } from "@carbon/icons-react";
import { InlineNotification, Tag } from "@carbon/react";
import type { BodyRef, ContentResponse } from "@contracts/api.ts";
import type { Selection } from "@contracts/selection.ts";
import { type ReactNode, useState } from "react";
import { Mono } from "../../atoms/Mono.tsx";
import { CallRow } from "../../molecules/CallRow.tsx";
import { KeyValue, KeyValueList } from "../../molecules/KeyValue.tsx";
import styles from "./DetailPanel.module.css";
import { bodyNote, type CallRowModel, type FieldModel, type NoticeModel, type TagModel } from "./model.ts";

/** What a view receives from the panel besides its own data. */
export interface ViewContext {
  onOpen: (sel: Selection) => void;
  /** Session start: the time "+6:12" is counted from it. */
  sessionStart?: number;
  onLoadContent?: (contentId: number) => Promise<ContentResponse>;
}

const TAG_ICONS = { error: ErrorFilled, success: CheckmarkFilled } as const;

export function StatusTag({ tag }: { tag: TagModel }) {
  return (
    <Tag type={tag.tone} size="sm" renderIcon={tag.icon && TAG_ICONS[tag.icon]}>
      {tag.label}
    </Tag>
  );
}

const TITLE_CLASS = {
  plain: styles.title,
  mono: `${styles.title} ${styles.titleMono}`,
  path: `${styles.title} ${styles.titlePath}`,
};

export interface PanelHeadProps {
  /** Kind of the item above the title: "Agent", "Tool call". */
  caption: string;
  title?: string;
  /** mono — a tool name; path — a file path, wraps at any character. */
  titleKind?: "plain" | "mono" | "path";
  tags?: TagModel[];
  /** Line under the title: agent description, call target, request address. */
  children?: ReactNode;
}

export function PanelHead({ caption, title, titleKind = "plain", tags = [], children }: PanelHeadProps) {
  return (
    <div className={styles.head}>
      <span className={styles.caption}>{caption}</span>
      {(title !== undefined || tags.length > 0) && (
        <div className={styles.titleRow}>
          {title !== undefined && <h2 className={TITLE_CLASS[titleKind]}>{title}</h2>}
          {tags.map((tag) => (
            <StatusTag key={tag.label} tag={tag} />
          ))}
        </div>
      )}
      {children}
    </div>
  );
}

export interface LinkButtonProps {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}

/** Link to another panel view: a button, not an address — the page performs the navigation. */
export function LinkButton({ children, onClick, disabled }: LinkButtonProps) {
  return (
    <button type="button" className={styles.link} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export function Fields({ fields, onOpen }: { fields: FieldModel[]; onOpen: (sel: Selection) => void }) {
  return (
    <KeyValueList>
      {fields.map((field) => {
        const { to } = field;
        const text = field.mono ? <Mono>{field.value}</Mono> : field.value;
        const value = field.title ? <span title={field.title}>{text}</span> : text;
        return (
          <KeyValue key={field.label} label={field.label} error={field.error}>
            {to ? <LinkButton onClick={() => onOpen(to)}>{value}</LinkButton> : value}
          </KeyValue>
        );
      })}
    </KeyValueList>
  );
}

/** Block of fields without a title. */
export function FieldsBlock(props: { fields: FieldModel[]; onOpen: (sel: Selection) => void }) {
  return (
    <div className={styles.block}>
      <Fields {...props} />
    </div>
  );
}

export interface PreProps {
  text: string;
  /** Error text: in the error color. */
  error?: boolean;
  /** Larger: prompt text. */
  large?: boolean;
}

/** Monospaced text with scrolling; it can take focus so that it scrolls from the keyboard. */
export function Pre({ text, error = false, large = false }: PreProps) {
  const className = [styles.pre, error && styles.preError, large && styles.preLarge]
    .filter(Boolean)
    .join(" ");
  return (
    <pre className={className} tabIndex={0}>
      {text}
    </pre>
  );
}

export interface BodyBlockProps extends Omit<PreProps, "text"> {
  body: BodyRef | null;
  /** Text in place of a body that does not exist. */
  emptyText: string;
  onLoadContent?: (contentId: number) => Promise<ContentResponse>;
}

/**
 * Body from `contents`: the beginning at once, the whole thing via "Show all". The state belongs to one
 * body: the view is recreated when the selection changes (key in DetailPanel).
 */
export function BodyBlock({ body, emptyText, onLoadContent, ...pre }: BodyBlockProps) {
  const [full, setFull] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "failed">("idle");

  if (!body) return <p className={styles.empty}>{emptyText}</p>;

  const note = full === null ? bodyNote(body) : null;
  const showAll = () => {
    if (!onLoadContent) return;
    setStatus("loading");
    onLoadContent(body.contentId).then(
      (content) => {
        setFull(content.text);
        setStatus("idle");
      },
      () => setStatus("failed"),
    );
  };

  return (
    <>
      <Pre text={full ?? body.preview} {...pre} />
      {note && (
        <p className={styles.bodyNote}>
          <span>{note}</span>
          {onLoadContent && (
            <LinkButton onClick={showAll} disabled={status === "loading"}>
              {status === "loading" ? "Loading…" : "Show all"}
            </LinkButton>
          )}
          {status === "failed" && (
            <span role="alert" className={styles.bodyError}>
              Could not load the full text.
            </span>
          )}
        </p>
      )}
    </>
  );
}

export interface CallListProps {
  rows: CallRowModel[];
  onSelect: (id: string) => void;
  /** Text instead of an empty list. */
  emptyText?: string;
}

export function CallList({ rows, onSelect, emptyText }: CallListProps) {
  if (rows.length === 0) {
    return emptyText ? <p className={`${styles.empty} ${styles.emptyList}`}>{emptyText}</p> : null;
  }
  return (
    <div role="list" className={styles.list}>
      {rows.map(({ id, ...row }) => (
        <div role="listitem" key={id}>
          <CallRow {...row} onSelect={() => onSelect(id)} />
        </div>
      ))}
    </div>
  );
}

export function Notice({ notice }: { notice: NoticeModel }) {
  return (
    <div className={styles.notice}>
      <InlineNotification kind="error" hideCloseButton title={notice.title} subtitle={notice.subtitle} />
    </div>
  );
}
