"use client";

import { Description, FieldError, Input, Label, ListBox, Select, TextArea, TextField } from "@heroui/react";
import type { ConnectKind } from "./read-only-sql";

/** What differs between the databases on the connection forms: defaults, examples, and what SSL mode means. */
export const SOURCE_KINDS: Record<
  ConnectKind,
  {
    title: string;
    port: string;
    sslMode: string;
    database: string;
    sslModes: { id: string; label: string; description: string }[];
    readOnlyNote: string;
  }
> = {
  postgres: {
    title: "Connect PostgreSQL",
    port: "5432",
    sslMode: "verify-full",
    database: "acme_production",
    sslModes: [
      { id: "verify-full", label: "verify-full", description: "Encrypted and verified" },
      { id: "require", label: "require", description: "Encrypted, not verified" },
      { id: "disable", label: "disable", description: "Not encrypted: private networks only" },
    ],
    readOnlyNote: "OpenDash still runs every query in a read-only transaction.",
  },
  clickhouse: {
    title: "Connect ClickHouse",
    port: "8443",
    sslMode: "verify-full",
    database: "default",
    // On ClickHouse the SSL mode picks HTTPS (verified or not) or plain HTTP.
    sslModes: [
      { id: "verify-full", label: "verify-full", description: "HTTPS, verified" },
      { id: "require", label: "require", description: "HTTPS, not verified" },
      { id: "disable", label: "disable (HTTP)", description: "Plain HTTP: private networks only" },
    ],
    readOnlyNote: "OpenDash still runs every query in ClickHouse's read-only mode.",
  },
  mysql: {
    title: "Connect MySQL",
    port: "3306",
    sslMode: "verify-full",
    database: "acme_production",
    sslModes: [
      { id: "verify-full", label: "verify-full", description: "Encrypted and verified" },
      { id: "require", label: "require", description: "Encrypted, not verified" },
      { id: "disable", label: "disable", description: "Not encrypted: private networks only" },
    ],
    readOnlyNote: "OpenDash still runs every query in a read-only transaction.",
  },
};

/** One labelled text input of the connection forms, with its error. */
export function Field({
  label,
  error,
  className,
  inputRef,
  placeholder,
  inputMode,
  ...props
}: {
  label: string;
  name: string;
  value: string;
  error?: string;
  className?: string;
  type?: string;
  autoComplete?: string;
  autoFocus?: boolean;
  placeholder?: string;
  inputMode?: "numeric";
  inputRef?: React.Ref<HTMLInputElement>;
  onChange: (value: string) => void;
}) {
  return (
    <TextField {...props} className={className} isInvalid={Boolean(error)}>
      <Label>{label}</Label>
      <Input ref={inputRef} placeholder={placeholder} inputMode={inputMode} required />
      {error ? <FieldError>{error}</FieldError> : null}
    </TextField>
  );
}

/** The SSL mode, with the choices the database kind has. */
export function SslModeSelect({
  kind,
  value,
  onChange,
  className = "w-40",
}: {
  kind: ConnectKind;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const k = SOURCE_KINDS[kind];
  return (
    <Select className={className} name="sslMode" value={value} onChange={(key) => onChange(String(key ?? k.sslMode))}>
      <Label>SSL mode</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox>
          {k.sslModes.map((mode) => (
            <ListBox.Item key={mode.id} id={mode.id} textValue={mode.label}>
              <span className="flex flex-col gap-0.5">
                <Label>{mode.label}</Label>
                <Description>{mode.description}</Description>
              </span>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

/**
 * Under the SSL mode, what it means where that needs saying: verify-full takes the CA that signed the server's
 * certificate when it's the company's own (OpenDash then trusts only that CA); require says it proves nothing.
 */
export function SslDetails({
  sslMode,
  ca,
  error,
  onCaChange,
}: {
  sslMode: string;
  ca: string;
  error?: string;
  onCaChange: (value: string) => void;
}) {
  if (sslMode === "require") {
    return (
      <p className="text-small text-muted">
        Encrypted, not verified: any server answering at this address is accepted. Use verify-full where you can.
      </p>
    );
  }
  if (sslMode !== "verify-full") return null;
  return (
    <TextField value={ca} onChange={onCaChange} isInvalid={Boolean(error)} className="flex flex-col gap-1.5">
      <Label>CA certificate (optional)</Label>
      <TextArea
        rows={3}
        spellCheck={false}
        placeholder="-----BEGIN CERTIFICATE-----"
        className="font-mono text-small"
      />
      {error ? (
        <FieldError>{error}</FieldError>
      ) : (
        <Description>
          Only when your own CA signed the server's certificate: OpenDash then trusts only that CA.
        </Description>
      )}
    </TextField>
  );
}
