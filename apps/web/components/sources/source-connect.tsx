"use client";

import { Alert, Button, buttonVariants, Checkbox } from "@heroui/react";
import { CodeBlock } from "@opendash/ui";
import { ArrowLeft, Globe } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { connectSource, type SourceFormInput, startConnectionTest } from "@/app/(app)/data/sources/new/actions";
import { PasswordField } from "@/components/auth/password-field";
import { CheckRow } from "./check-row";
import { CLICKHOUSE_PLAYGROUND, CLICKHOUSE_PLAYGROUND_DOCS } from "./playground";
import { type ConnectKind, readOnlyUserSql } from "./read-only-sql";
import { Field, SOURCE_KINDS, SslDetails, SslModeSelect } from "./source-fields";
import { StepHeading } from "./step-heading";
import { useConnectionTest } from "./use-connection-test";

type Values = Omit<SourceFormInput, "dialect">;
type FieldErrors = Partial<Record<keyof Values, string>>;

/** The endpoint a test was run against; editing any of these makes the result stale. */
const endpoint = (v: Values) =>
  [v.host.trim().toLowerCase(), v.port.trim(), v.database.trim(), v.user.trim(), v.sslMode, (v.ca ?? "").trim()].join(
    "\n",
  );

/**
 * Connecting a source: the settings and the live check, then a warning if the user can change data. The password goes to the server once per
 * test and is stored encrypted; the check runs in a worker, and this form polls its progress. `playground` starts the
 * ClickHouse form filled in with ClickHouse's public playground.
 */
export function SourceConnect({
  kind,
  egress,
  queuedWarningMs,
  playground = false,
}: {
  kind: ConnectKind;
  egress: string[];
  queuedWarningMs: number;
  playground?: boolean;
}) {
  const k = SOURCE_KINDS[kind];
  const [values, setValues] = useState<Values>(
    playground
      ? CLICKHOUSE_PLAYGROUND
      : { host: "", port: k.port, database: "", user: "", password: "", sslMode: k.sslMode, ca: "" },
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [testId, setTestId] = useState<string | null>(null);
  const { test, slowWorker, running: checking } = useConnectionTest(testId, queuedWarningMs);
  const [tested, setTested] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [accept, setAccept] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const userRef = useRef<HTMLInputElement>(null);

  const running = requesting || checking;
  const current = test !== null && tested === endpoint(values);

  // A check that found write access (or worse) is reviewed before anything else.
  useEffect(() => {
    if (test?.status === "warning" || test?.status === "blocked") setReviewing(true);
  }, [test?.status]);

  const set = (key: keyof Values) => (value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  async function runTest(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    setMessage(null);
    setAccept(false);
    setRequesting(true);
    const result = await startConnectionTest({ ...values, dialect: kind });
    setRequesting(false);
    if (!result.ok) {
      setErrors(result.errors ?? {});
      setMessage(result.message ?? null);
      return;
    }
    setTested(endpoint(values));
    setTestId(result.testId);
  }

  async function connect() {
    if (!test) return;
    setConnecting(true);
    const result = await connectSource({ testId: test.id, acceptWriteAccess: accept });
    // Success redirects to Sources; anything returned is a reason it didn't happen.
    setConnecting(false);
    setMessage(result.message);
  }

  function switchUser() {
    setReviewing(false);
    setTestId(null);
    setValues((v) => ({ ...v, user: "", password: "" }));
    setTimeout(() => userRef.current?.focus(), 0);
  }

  const alert = message ? (
    <Alert status="danger">
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Description>{message}</Alert.Description>
      </Alert.Content>
    </Alert>
  ) : null;

  const checks = test?.checks.length ? (
    <ul aria-live="polite" className="flex flex-col">
      {test.checks.map((check) => (
        <CheckRow key={check.key} check={check} />
      ))}
    </ul>
  ) : null;

  // The user can change data (warning), or reaches beyond the data altogether (blocked, no override).
  if (reviewing && test && current && (test.status === "warning" || test.status === "blocked")) {
    const blocked = test.status === "blocked";
    return (
      <div className="flex flex-col gap-6">
        <StepHeading title={blocked ? "This user can't be connected" : "This user can change data"}>
          {blocked
            ? "OpenDash never connects as a user that reaches beyond your data, so there's nothing to override. Use a read-only user."
            : "OpenDash only ever reads. Connect with a read-only user so a mistake can't write to production."}
        </StepHeading>
        {alert}
        {checks}
        <div className="flex flex-col gap-2.5">
          <p className="text-body font-medium">Create a read-only user (run as an admin):</p>
          <CodeBlock code={readOnlyUserSql(kind, test.config.database)} label="Copy SQL" />
        </div>
        {blocked ? null : (
          <Checkbox isSelected={accept} onChange={setAccept}>
            <Checkbox.Content>
              <Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control>
              Connect anyway. {k.readOnlyNote}
            </Checkbox.Content>
          </Checkbox>
        )}
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="lg" onPress={() => setReviewing(false)}>
            <ArrowLeft className="size-4" aria-hidden />
            Back
          </Button>
          <span className="flex-1" />
          <Button variant={accept ? "outline" : "primary"} size="lg" onPress={switchUser}>
            Use a different user
          </Button>
          {accept && !blocked ? (
            <Button size="lg" isPending={connecting} onPress={connect}>
              Connect anyway
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  const passed = current && test?.status === "passed";
  return (
    <div className="flex flex-col gap-6">
      <StepHeading title={playground ? "Connect ClickHouse's playground" : k.title}>
        {playground ? (
          <>
            ClickHouse's public sample datasets, filled in below: read-only, no password.{" "}
            <a href={CLICKHOUSE_PLAYGROUND_DOCS} target="_blank" rel="noreferrer" className="text-link hover:underline">
              About the datasets
            </a>
          </>
        ) : (
          "Use a read-only user. We check its permissions before anything else runs."
        )}
      </StepHeading>
      {alert}
      <form className="auth-form flex flex-col gap-3.5" onSubmit={runTest}>
        <div className="flex gap-3">
          <Field
            label="Host"
            name="host"
            className="flex-1"
            value={values.host}
            error={errors.host}
            onChange={set("host")}
            placeholder="db.acme.com"
            autoFocus
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
        <div className="flex gap-3">
          <Field
            label="Database"
            name="database"
            className="flex-1"
            value={values.database}
            error={errors.database}
            onChange={set("database")}
            placeholder={k.database}
          />
          <Field
            label="Username"
            name="user"
            className="flex-1"
            value={values.user}
            error={errors.user}
            onChange={set("user")}
            placeholder="opendash_reader"
            inputRef={userRef}
          />
        </div>
        <div className="flex gap-3">
          <PasswordField
            className="flex-1"
            value={values.password}
            error={errors.password}
            onChange={set("password")}
            autoComplete="off"
            required={false}
            description="Leave empty if this user has no password."
          />
          <SslModeSelect kind={kind} value={values.sslMode} onChange={set("sslMode")} />
        </div>
        <SslDetails sslMode={values.sslMode} ca={values.ca ?? ""} error={errors.ca} onCaChange={set("ca")} />
        {/* Keeps Enter in any field submitting the form, whichever buttons are showing. */}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
      {egress.length ? (
        <div className="flex gap-2.5 rounded-2xl bg-accent-soft px-3 py-2.5">
          <Globe className="mt-0.5 size-4 shrink-0 text-accent-soft-foreground" aria-hidden />
          <div className="flex flex-col gap-0.5">
            <p className="text-body font-medium text-accent-soft-foreground">Using an IP allowlist?</p>
            <p className="text-body text-muted">
              Allow {egress.join(" and ")}. OpenDash Cloud always connects from these addresses.
            </p>
          </div>
        </div>
      ) : null}
      {current ? checks : null}
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
      <div className="flex items-center gap-2">
        <Link href="/data/sources/new" className={`${buttonVariants({ variant: "ghost", size: "lg" })} gap-1`}>
          <ArrowLeft className="size-4" aria-hidden />
          Back
        </Link>
        <span className="flex-1" />
        {passed ? (
          <>
            <Button variant="outline" size="lg" isDisabled={connecting} onPress={() => runTest()}>
              Test again
            </Button>
            <Button size="lg" isPending={connecting} onPress={connect}>
              Connect
            </Button>
          </>
        ) : current && test && (test.status === "warning" || test.status === "blocked") ? (
          <Button size="lg" onPress={() => setReviewing(true)}>
            Review access
          </Button>
        ) : (
          <Button size="lg" isPending={running} onPress={() => runTest()}>
            {current && test?.status === "failed" ? "Test again" : "Test connection"}
          </Button>
        )}
      </div>
    </div>
  );
}
