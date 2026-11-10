// Read-only blocks: data locations, enrichment channels, retention.
import { Tag } from "@carbon/react";
import type { SettingsResponse } from "@contracts/api.ts";
import { Mono } from "../../../components/atoms/Mono.tsx";
import { KeyValue, KeyValueList } from "../../../components/molecules/KeyValue.tsx";
import { channelStatus, retentionLabel } from "../model.ts";

const PATH_LABELS: { key: keyof SettingsResponse["paths"]; label: string }[] = [
  { key: "dataDir", label: "Data directory" },
  { key: "db", label: "Database" },
  { key: "transcripts", label: "Transcripts" },
  { key: "desktopSessions", label: "Desktop sessions" },
  { key: "spool", label: "Hooks spool" },
  { key: "claudeSettings", label: "Claude Code settings" },
];

export function DataPaths({ paths }: { paths: SettingsResponse["paths"] }) {
  return (
    <KeyValueList>
      {PATH_LABELS.map(({ key, label }) => (
        <KeyValue key={key} label={label}>
          <Mono size="md">{paths[key]}</Mono>
        </KeyValue>
      ))}
    </KeyValueList>
  );
}

const CHANNELS: { key: keyof SettingsResponse["channels"]; label: string }[] = [
  { key: "otel", label: "OpenTelemetry logs" },
  { key: "hooks", label: "Hooks" },
];

export function Channels({ channels }: { channels: SettingsResponse["channels"] }) {
  return (
    <KeyValueList>
      {CHANNELS.map(({ key, label }) => {
        const { label: status, detail } = channelStatus(channels[key]);
        return (
          <KeyValue key={key} label={label}>
            <Tag type={channels[key].configured ? "green" : "gray"} size="md">
              {status}
            </Tag>{" "}
            {detail}
          </KeyValue>
        );
      })}
    </KeyValueList>
  );
}

export function Retention({ days }: { days: SettingsResponse["cleanupPeriodDays"] }) {
  return (
    <KeyValueList>
      <KeyValue label="Transcript retention (cleanupPeriodDays)">{retentionLabel(days)}</KeyValue>
    </KeyValueList>
  );
}
