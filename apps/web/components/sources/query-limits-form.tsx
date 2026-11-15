"use client";

import { Button, toast } from "@heroui/react";
import type { LimitErrors, SourceLimits } from "@opendash/core";
import { useState, useTransition } from "react";
import { setSourceLimitsAction } from "@/app/(app)/data/sources/actions";
import { Field } from "./source-fields";

type Ranges = Record<keyof SourceLimits, { min: number; max: number }>;

/** Query limits: parallel queries, statement timeout and rows read, each within the gateway's own budget. */
export function QueryLimitsForm({ id, limits, ranges }: { id: string; limits: SourceLimits; ranges: Ranges }) {
  const initial = {
    parallel: String(limits.parallel),
    statementSeconds: String(limits.statementMs / 1000),
    maxRows: String(limits.maxRows),
  };
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<LimitErrors>({});
  const [pending, start] = useTransition();
  const changed = JSON.stringify(values) !== JSON.stringify(initial);
  // Typing clears that field's error: an invalid field would otherwise keep the browser from submitting the form.
  const errorKey = { parallel: "parallel", statementSeconds: "statementMs", maxRows: "maxRows" } as const;
  const set = (key: keyof typeof values) => (value: string) => {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => ({ ...e, [errorKey[key]]: undefined }));
  };
  return (
    <form
      className="flex flex-col gap-3.5"
      onSubmit={(event) => {
        event.preventDefault();
        start(async () => {
          setErrors({});
          const result = await setSourceLimitsAction(id, {
            parallel: Number(values.parallel),
            statementSeconds: Number(values.statementSeconds),
            maxRows: Number(values.maxRows),
          });
          if (result?.errors) setErrors(result.errors);
          else if (result?.message) toast.danger(result.message);
          else toast.success("Limits saved");
        });
      }}
    >
      <div className="flex gap-3">
        <Field
          label="Parallel queries"
          name="parallel"
          className="flex-1"
          inputMode="numeric"
          value={values.parallel}
          error={errors.parallel}
          onChange={set("parallel")}
        />
        <Field
          label="Statement timeout (s)"
          name="statementSeconds"
          className="flex-1"
          inputMode="numeric"
          value={values.statementSeconds}
          error={errors.statementMs}
          onChange={set("statementSeconds")}
        />
        <Field
          label="Max rows read"
          name="maxRows"
          className="flex-1"
          inputMode="numeric"
          value={values.maxRows}
          error={errors.maxRows}
          onChange={set("maxRows")}
        />
      </div>
      <div className="flex items-center gap-2">
        <Button type="submit" variant="outline" isDisabled={!changed} isPending={pending}>
          Save limits
        </Button>
        <span className="text-small text-muted-tertiary">
          Up to {ranges.parallel.max} at once, {ranges.statementMs.max / 1000} s and{" "}
          {ranges.maxRows.max.toLocaleString("en-US")} rows: OpenDash never goes past its own limits.
        </span>
      </div>
    </form>
  );
}
