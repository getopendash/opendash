/**
 * The demo company's glossary: the starter terms proposed for the sample source, and the words the
 * glossary questions of DashBench depend on. The definitions are this business's own on purpose (SMB is under 50
 * employees, mid-market starts at 51, the fiscal year starts in February), so an analyst that guesses gets them wrong
 * and one that reads the glossary gets them right: that's the lift being measured. `{{public}}` is the source's public schema (ClickHouse
 * databases may carry a prefix).
 */
export const DEMO_GLOSSARY: string[] = [
  `term: SMB
means: Small businesses, here accounts with up to 50 employees.
synonyms: [small business, small businesses, SMBs]
maps_to:
  column: "{{public}}.accounts.employee_band"
  values: ["1-10", "11-50"]
`,
  `term: Mid-market
means: Accounts with 51 to 1,000 employees.
synonyms: [midmarket, mid market]
maps_to:
  column: "{{public}}.accounts.employee_band"
  values: ["51-200", "201-1000"]
`,
  `term: Enterprise
means: Accounts with more than 1,000 employees.
synonyms: [enterprise accounts, large accounts]
maps_to:
  column: "{{public}}.accounts.employee_band"
  values: ["1000+"]
`,
  `term: Fiscal year
means: Our fiscal year starts on February 1 and is named for the calendar year it starts in. FY2026 runs from February 2026 to January 2027, so its Q1 is February to April, Q2 May to July, Q3 August to October and Q4 November to January.
synonyms: [FY, fiscal quarter, fiscal Q1, fiscal Q2, fiscal Q3, fiscal Q4]
`,
  `term: Active customer
means: An account paying us at the end of a month (on a paid plan, not trialing or paused), as the Paying customers metric counts it.
synonyms: [active customers, active accounts]
maps_to:
  metric: paying_customers
`,
];

/** The glossary for a source whose public schema is `publicSchema`. */
export const demoGlossary = (publicSchema = "public") =>
  DEMO_GLOSSARY.map((t) => t.replaceAll("{{public}}", publicSchema));
