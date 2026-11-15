"use client";

import { Button, Description, FieldError, InputGroup, Label, TextField } from "@heroui/react";
import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";

export const MIN_PASSWORD_LENGTH = 10;

export function PasswordField({
  name = "password",
  label = "Password",
  autoComplete = "current-password",
  placeholder,
  description,
  error,
  autoFocus,
  value,
  onChange,
  className,
  required = true,
}: {
  name?: string;
  label?: string;
  /** new-password also asks for the minimum length; "off" is for credentials that aren't the user's own. */
  autoComplete?: "current-password" | "new-password" | "off";
  placeholder?: string;
  description?: string;
  error?: string | null;
  autoFocus?: boolean;
  /** Controlled use (e.g. a form that keeps its values between attempts). */
  value?: string;
  onChange?: (value: string) => void;
  className?: string;
  /** False for credentials that may be empty, like a database user without a password. */
  required?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  const isNew = autoComplete === "new-password";
  return (
    <TextField
      name={name}
      minLength={isNew ? MIN_PASSWORD_LENGTH : undefined}
      isInvalid={Boolean(error)}
      autoComplete={autoComplete}
      autoFocus={autoFocus}
      value={value}
      onChange={onChange}
      className={className}
    >
      <Label>{label}</Label>
      <InputGroup>
        <InputGroup.Input type={visible ? "text" : "password"} placeholder={placeholder} required={required} />
        <InputGroup.Suffix className="pe-0">
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label={visible ? "Hide password" : "Show password"}
            onPress={() => setVisible((v) => !v)}
          >
            {visible ? <EyeOff /> : <Eye />}
          </Button>
        </InputGroup.Suffix>
      </InputGroup>
      {error ? <FieldError>{error}</FieldError> : description ? <Description>{description}</Description> : null}
    </TextField>
  );
}
