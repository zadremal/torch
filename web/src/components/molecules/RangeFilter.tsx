// Molecule: two fields of one "from and to" range — Min and Max in the session list filters,
// From and To of the Custom range on the dashboard. Values are input field strings; an empty string
// means "bound not set".
import { TextInput } from "@carbon/react";
import { useId } from "react";
import "./RangeFilter.scss";

export interface RangeValue {
  min: string;
  max: string;
}

export interface RangeFilterProps {
  /** Name of the field pair: "Tool calls", "Date range". */
  legend: string;
  /** Hide the name visually, leaving it to assistive technologies. */
  hideLegend?: boolean;
  /** number — narrow sm fields with the hints "0" and "Any"; date — date fields. */
  type?: "number" | "date";
  minLabel?: string;
  maxLabel?: string;
  value: RangeValue;
  onChange: (value: RangeValue) => void;
}

export function RangeFilter({
  legend,
  hideLegend = false,
  type = "number",
  minLabel = "Min",
  maxLabel = "Max",
  value,
  onChange,
}: RangeFilterProps) {
  const id = useId();
  const isNumber = type === "number";
  const shared = { type, size: isNumber ? "sm" : "md", min: isNumber ? 0 : undefined } as const;
  return (
    <fieldset className={`torch-range torch-range--${type}`}>
      <legend className={hideLegend ? "cds--visually-hidden" : "torch-range__legend"}>{legend}</legend>
      <div className="torch-range__fields">
        <TextInput
          {...shared}
          id={`${id}-min`}
          labelText={minLabel}
          placeholder={isNumber ? "0" : undefined}
          value={value.min}
          onChange={(event) => onChange({ ...value, min: event.target.value })}
        />
        <TextInput
          {...shared}
          id={`${id}-max`}
          labelText={maxLabel}
          placeholder={isNumber ? "Any" : undefined}
          value={value.max}
          onChange={(event) => onChange({ ...value, max: event.target.value })}
        />
      </div>
    </fieldset>
  );
}
