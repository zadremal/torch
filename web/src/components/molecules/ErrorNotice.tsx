// Molecule: a load error message with a retry button.
// ActionableNotification rather than InlineNotification with a button inside: the latter throws if
// an interactive element is among its descendants.
import { ActionableNotification } from "@carbon/react";

export interface ErrorNoticeProps {
  title: string;
  error: Error;
  onRetry: () => void;
}

export function ErrorNotice({ title, error, onRetry }: ErrorNoticeProps) {
  return (
    <ActionableNotification
      kind="error"
      inline
      lowContrast
      hideCloseButton
      hasFocus={false}
      title={title}
      subtitle={error.message}
      actionButtonLabel="Retry"
      onActionButtonClick={onRetry}
    />
  );
}
