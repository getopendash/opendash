"use client";

import { Alert, Button, Description, FieldError, Input, InputGroup, Label, TextField } from "@heroui/react";
import { authClient } from "@opendash/auth/client";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { adoptWorkspaceTzAction } from "@/app/(auth)/onboarding/organization/actions";

const slugify = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;

/** The organization holds the team's data, definitions and dashboards. */
export function CreateOrganizationForm({ host }: { host: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [slugError, setSlugError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const value = slugEdited ? slug : slugify(name);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!SLUG.test(value)) {
      setSlugError("Use 3–48 lowercase letters, numbers or hyphens.");
      return;
    }
    setSlugError(null);
    setPending(true);
    const result = await authClient.organization.create({ name: name.trim(), slug: value });
    if (result.error) {
      setPending(false);
      const code = result.error.code ?? "";
      if (code.includes("SLUG") || code.includes("ALREADY_EXISTS"))
        setSlugError("That URL name is taken. Try another.");
      else if (code.includes("NOT_ALLOWED")) setError("Only your admin can create organizations on this OpenDash.");
      else setError("We couldn't create the organization. Try again.");
      return;
    }
    // Its routines run at its creator's hours from the start; if this fails it stays UTC, changed later in Routines.
    await adoptWorkspaceTzAction(Intl.DateTimeFormat().resolvedOptions().timeZone).catch(() => null);
    // Onboarding continues with connecting data.
    router.push("/data/sources/new");
    router.refresh();
  }

  return (
    <form className="auth-form flex flex-col gap-4" onSubmit={onSubmit}>
      {error ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      <TextField
        name="name"
        value={name}
        onChange={(next) => {
          setName(next);
          // A new name is a new URL name, unless it was typed: the old "taken" no longer applies.
          if (!slugEdited) setSlugError(null);
        }}
        autoComplete="organization"
        autoFocus
      >
        <Label>Organization name</Label>
        <Input placeholder="Acme" required />
      </TextField>
      <TextField
        name="slug"
        value={value}
        isInvalid={Boolean(slugError)}
        onChange={(next) => {
          setSlugEdited(true);
          setSlug(next.toLowerCase());
          // An invalid field blocks the form's submit, so an error must clear as soon as the URL name changes.
          setSlugError(null);
        }}
      >
        <Label>URL name</Label>
        <InputGroup>
          <InputGroup.Prefix>{host}/</InputGroup.Prefix>
          <InputGroup.Input placeholder="acme" required />
        </InputGroup>
        {slugError ? (
          <FieldError>{slugError}</FieldError>
        ) : (
          <Description>Used in links to {name.trim() || "your organization"}. You can change it later.</Description>
        )}
      </TextField>
      <Button type="submit" size="lg" isPending={pending} fullWidth className="mt-2">
        Create organization
      </Button>
    </form>
  );
}
