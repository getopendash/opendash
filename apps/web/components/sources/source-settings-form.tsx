"use client";

import { Alert, Button, Checkbox } from "@heroui/react";
import { type FormEvent, useState } from "react";
import { saveSourceUpdate, startSourceUpdateTest } from "@/app/(app)/data/sources/actions";
import { PasswordField } from "@/components/auth/password-field";
import { CheckRow } from "./check-row";
import type { ConnectKind } from "./read-only-sql";
import { Field, SOURCE_KINDS, SslDetails, SslModeSelect } from "./source-fields";
import { useConnectionTest } from "./use-connection-test";

export interface SettingsSource {
  id: string;
  dialect: string;
  host: string;
  port: number | null;
  database: string;
  user: string;
  sslMode: string | null;
  ca: string | null;
}

interface Values {
  host: string;
  port: string;
  database: string;
  user: string;
  sslMode: string;
  ca: string;
  password: string;
}
type Errors = Partial<Record<keyof Values, string>>;

/**
 * Changing how OpenDash connects to a source: Settings' Connection section (every setting; the saved password is kept
 * unless it's changed, and only on the same host and port) and Reconnect's Update credentials (the user and a new password).
 * Nothing changes until the new settings pass the same check as a new source; saving then learns the source again.
 */
export function SourceSettingsForm({
  source,
  mode,
  queuedWarningMs,
}: {
  source: SettingsSource;
  mode: "settings" | "reconnect";
  queuedWarningMs: number;
}) {
  const kind: ConnectKind = source.dialect === "clickhouse" || source.dialect === "mysql" ? source.dialect : "postgres";
  const k = SOURCE_KINDS[kind];
  const initial: Values = {
    host: source.host,
    port: String(source.port ?? k.port),
    database: source.database,
    user: source.user,
    sslMode: source.sslMode ?? k.sslMode,
    ca: source.ca ?? "",
    password: "",
  };
  const [values, setValues] = useState(initial);
  const [changePassword, setChangePassword] = useState(mode === "reconnect");
  const [errors, setErrors] = useState<Errors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [testId, setTestId] = useState<string | null>(null);
  const [tested, setTested] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [accept, setAccept] = useState(false);
  const { test, slowWorker, running } = useConnectionTest(testId, queuedWarningMs);

  const key = JSON.stringify([values, changePassword]);
  const current = test !== null && tested === key;
  const dirty = changePassword || (Object.keys(initial) as (keyof Values)[]).some((f) => values[f] !== initial[f]);
  const set = (field: keyof Values) => (value: string) => {
    setValues((v) => ({ ...v, [field]: value }));
    setErrors((e) => ({ ...e, [field]: undefined }));
  };

  async function runTest(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!dirty) return;
    setMessage(null);
    setAccept(false);
    setRequesting(true);
    const { password, ...settings } = values;
    const result = await startSourceUpdateTest(source.id, { ...settings, password: changePassword ? password : null });
    setRequesting(false);
    if (!result.ok) {
      // The saved password can't go to another server or over weaker SSL: ask for it where it's typed.
      if (result.errors?.password) setChangePassword(true);
      setErrors(result.errors ?? {});
      setMessage(result.message ?? null);
      return;
    }
    setTested(key);
    setTestId(result.testId);
  }

  async function save() {
    if (!test) return;
    setSaving(true);
    // Success opens the source's overview, learning it again; anything returned is why it didn't happen.
    const result = await saveSourceUpdate(source.id, { testId: test.id, acceptWriteAccess: accept });
    setSaving(false);
    setMessage(result.message);
  }

  const outcome = current ? test?.status : undefined;
  const canSave = outcome === "passed" || (outcome === "warning" && accept);
  return (
    <form className="flex flex-col gap-3.5" onSubmit={runTest}>
      {mode === "settings" ? (
        <>
          <div className="flex gap-3">
            <Field
              label="Host"
              name="host"
              className="flex-1"
              value={values.host}
              error={errors.host}
              onChange={set("host")}
            />
            <Field
              label="Port"
              name="port"
              className="w-24"
              value={values.port}
              error={errors.port}
              onChange={set("port")}
              inputMode="numeric"
            />
          </div>
          <Field
            label="Database"
            name="database"
            value={values.database}
            error={errors.database}
            onChange={set("database")}
          />
        </>
      ) : null}
      <div className="flex gap-3">
        <Field
          label="Username"
          name="user"
          className="flex-1"
          value={values.user}
          error={errors.user}
          onChange={set("user")}
        />
        {mode === "settings" ? <SslModeSelect kind={kind} value={values.sslMode} onChange={set("sslMode")} /> : null}
      </div>
      {mode === "settings" ? (
        <SslDetails sslMode={values.sslMode} ca={values.ca} error={errors.ca} onCaChange={set("ca")} />
      ) : null}
      {changePassword ? (
        <PasswordField
          value={values.password}
          error={errors.password}
          onChange={set("password")}
          autoComplete="off"
          required={false}
          autoFocus={mode === "reconnect"}
          description="Stored encrypted and never shown again. Leave empty if this user has no password."
        />
      ) : (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border px-3 py-2 text-body">
          <span className="text-muted">Password: saved, stored encrypted</span>
          <Button size="sm" variant="ghost" onPress={() => setChangePassword(true)}>
            Change
          </Button>
        </div>
      )}

      {message ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{message}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {current && test?.checks.length ? (
        <ul aria-live="polite" className="flex flex-col">
          {test.checks.map((check) => (
            <CheckRow key={check.key} check={check} />
          ))}
        </ul>
      ) : null}
      {slowWorker ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>
              No worker has picked up the check yet. Make sure the OpenDash worker is running.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {outcome === "blocked" ? (
        <p className="text-body text-danger">
          This user reaches beyond your data, so OpenDash can't use it. Use a read-only user.
        </p>
      ) : null}
      {outcome === "warning" ? (
        <Checkbox isSelected={accept} onChange={setAccept}>
          <Checkbox.Content>
            <Checkbox.Control>
              <Checkbox.Indicator />
            </Checkbox.Control>
            This user can change data. Save anyway. {k.readOnlyNote}
          </Checkbox.Content>
        </Checkbox>
      ) : null}

      <div className="flex items-center gap-2 pt-1">
        {canSave ? (
          <Button isPending={saving} onPress={save}>
            {mode === "reconnect" ? "Save and sync" : "Save changes"}
          </Button>
        ) : (
          <Button type="submit" isDisabled={!dirty} isPending={requesting || running}>
            {current && outcome ? "Test again" : "Test connection"}
          </Button>
        )}
        <span className="text-small text-muted-tertiary">
          {!dirty
            ? "Change a setting to test it."
            : canSave
              ? "Saving learns the source again."
              : "Nothing changes until the check passes."}
        </span>
      </div>
    </form>
  );
}
