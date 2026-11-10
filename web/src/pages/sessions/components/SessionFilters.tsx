// The session list filters block: search, Agents buckets, three ranges, project, temp directories, reset.
// It holds no state: values come in via props, changes go out via a callback.
import { Button, Checkbox, Search, Select, SelectItem } from "@carbon/react";
import { RangeFilter } from "../../../components/molecules/RangeFilter.tsx";
import { SegmentedControl, type SegmentedOption } from "../../../components/molecules/SegmentedControl.tsx";
import type { AgentsBucket } from "@contracts/api.ts";
import type { SessionsState } from "../query.ts";
import styles from "./SessionFilters.module.css";

const AGENT_OPTIONS: readonly SegmentedOption<AgentsBucket>[] = [
  { value: "any", label: "Any" },
  { value: "one", label: "1" },
  { value: "few", label: "2–3" },
  { value: "many", label: "4+" },
];

export interface SessionFiltersProps {
  state: SessionsState;
  projects: readonly { name: string; sessions: number }[];
  canReset: boolean;
  onChange: (change: Partial<SessionsState>) => void;
  onReset: () => void;
}

export function SessionFilters({ state, projects, canReset, onChange, onReset }: SessionFiltersProps) {
  return (
    <div className={styles.root}>
      <Search
        size="lg"
        labelText="Search sessions by name"
        placeholder="Search by session name"
        value={state.q}
        onChange={(event) => onChange({ q: event.target.value })}
        onClear={() => onChange({ q: "" })}
      />
      <div className={styles.row}>
        <SegmentedControl
          label="Agents"
          showLabel
          options={AGENT_OPTIONS}
          value={state.agents}
          onChange={(agents) => onChange({ agents })}
        />
        <RangeFilter
          legend="Tool calls"
          value={{ min: state.tcMin, max: state.tcMax }}
          onChange={({ min, max }) => onChange({ tcMin: min, tcMax: max })}
        />
        <RangeFilter
          legend="Errors"
          value={{ min: state.erMin, max: state.erMax }}
          onChange={({ min, max }) => onChange({ erMin: min, erMax: max })}
        />
        <RangeFilter
          legend="Total tokens (K)"
          value={{ min: state.tkMin, max: state.tkMax }}
          onChange={({ min, max }) => onChange({ tkMin: min, tkMax: max })}
        />
        <div className={styles.project}>
          <Select
            id="sessions-project"
            size="sm"
            labelText="Project"
            value={state.project}
            onChange={(event) => onChange({ project: event.target.value })}
          >
            <SelectItem value="" text="All projects" />
            {/* A project from the address that is not in the list (for example, from another selection) stays selected. */}
            {state.project !== "" && !projects.some((p) => p.name === state.project) && (
              <SelectItem value={state.project} text={state.project} />
            )}
            {projects.map((p) => (
              <SelectItem key={p.name} value={p.name} text={`${p.name} (${p.sessions})`} />
            ))}
          </Select>
        </div>
        <Checkbox
          id="sessions-temp"
          labelText="Show temporary directories"
          checked={state.temp}
          onChange={(_, { checked }) => onChange({ temp: checked })}
        />
        <Button kind="ghost" size="sm" disabled={!canReset} onClick={onReset}>
          Reset filters
        </Button>
      </div>
    </div>
  );
}
