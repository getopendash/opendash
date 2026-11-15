import "server-only";
import { goalMetricChoices, listGoals } from "@opendash/core";
import { withTenant } from "@opendash/db";

/** The goals, each with its metric's latest tested value (Home). */
export const goalsFor = (orgId: string) => withTenant({ orgId }, (tx) => listGoals(tx, orgId));

/** The verified metrics a goal can be on. */
export const goalMetricsFor = (orgId: string) => withTenant({ orgId }, (tx) => goalMetricChoices(tx, orgId));
