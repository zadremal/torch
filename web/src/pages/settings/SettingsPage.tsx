// The Settings page, route /settings. Package W7.
// Prices are edited as a draft and saved with PUT; paths, channels and retention are only shown.
import { Button, InlineNotification } from "@carbon/react";
import { useEffect, useMemo, useState } from "react";
import { ErrorNotice } from "../../components/molecules/ErrorNotice.tsx";
import { Section } from "../../components/molecules/Section.tsx";
import { PageLayout } from "../../components/templates/PageLayout.tsx";
import { api } from "../../lib/api.ts";
import { useApi } from "../../lib/useApi.ts";
import { Channels, DataPaths, Retention } from "./components/Overview.tsx";
import { PricesTable } from "./components/PricesTable.tsx";
import { type Draft, addRow, editRow, isChanged, parseDraft, removeRow, toDraft } from "./model.ts";
import "./SettingsPage.scss";

export function SettingsPage() {
  const settings = useApi(() => api.settings(), []);
  const data = settings.data;

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<Error | null>(null);
  const [saved, setSaved] = useState(false);

  // A new server response (first load, retry, save) replaces the draft.
  useEffect(() => {
    if (data) setDraft(toDraft(data.prices));
  }, [data]);

  const parsed = useMemo(() => (data && draft ? parseDraft(draft, data.prices) : null), [data, draft]);
  const errors = parsed && !parsed.ok ? parsed.errors : new Map<number, string>();
  const changed = data && draft ? isChanged(draft, data.prices) : false;

  const change = (next: (draft: Draft) => Draft) => {
    setSaved(false);
    setDraft((prev) => (prev ? next(prev) : prev));
  };

  const save = async () => {
    if (!parsed?.ok) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.saveSettings({ prices: parsed.prices });
      setSaved(true);
      settings.reload();
    } catch (e) {
      setSaveError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageLayout title="Settings" description="Prices, data locations and enrichment channels">
      {settings.error && <ErrorNotice title="Could not load the settings" error={settings.error} onRetry={settings.reload} />}
      {!data && settings.loading && <p className="torch-settings__loading">Loading…</p>}
      {data && draft && (
        <>
          <Section id="settings-prices" title="Prices" aside={`US dollars per million tokens · updated ${data.prices.updated}`}>
            <PricesTable
              rows={draft.rows}
              errors={errors}
              onModelChange={(key, model) => change((d) => editRow(d, key, (row) => ({ ...row, model })))}
              onCellChange={(key, field, value) =>
                change((d) => editRow(d, key, (row) => ({ ...row, cells: { ...row.cells, [field]: value } })))
              }
              onRemove={(key) => change((d) => removeRow(d, key))}
              onAdd={() => change(addRow)}
            />
            <p className="torch-settings__note">
              Source: {data.prices.source}. Saving recalculates the cost of every stored call; a model missing from the table
              shows no cost.
            </p>
            {saveError && (
              <InlineNotification kind="error" lowContrast hideCloseButton title="Could not save prices" subtitle={saveError.message} />
            )}
            {saved && !changed && (
              <InlineNotification kind="success" lowContrast hideCloseButton title="Prices saved" subtitle="Costs are recalculated." />
            )}
            <div className="torch-settings__actions">
              <Button kind="primary" size="md" disabled={!changed || !parsed?.ok || saving} onClick={save}>
                {saving ? "Saving…" : "Save prices"}
              </Button>
              <Button kind="secondary" size="md" disabled={!changed || saving} onClick={() => change(() => toDraft(data.prices))}>
                Discard changes
              </Button>
            </div>
          </Section>

          <Section id="settings-paths" title="Data locations">
            <DataPaths paths={data.paths} />
          </Section>

          <Section id="settings-channels" title="Enrichment channels" aside="Exact durations and permissions come from these channels">
            <Channels channels={data.channels} />
          </Section>

          <Section id="settings-retention" title="Retention">
            <Retention days={data.cleanupPeriodDays} />
          </Section>
        </>
      )}
    </PageLayout>
  );
}
