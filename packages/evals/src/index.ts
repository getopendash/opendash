// DashBench generators, golden questions, graders, runner.

export {
  computeGroundTruth,
  DEFAULT_SEED as LUMEN_DEFAULT_SEED,
  type DemoCommerceOptions,
  defaultAsOf as lumenDefaultAsOf,
  GROUND_TRUTH as LUMEN_GROUND_TRUTH,
  generateLumen,
  grantLumenReader,
  LUMEN_DATA_MARKER,
  LUMEN_DATABASE,
  LUMEN_GLOSSARY,
  LUMEN_GUIDES,
  LUMEN_QUESTIONS,
  LUMEN_READER,
  type LumenCompany,
  LumenMeasures,
  type LumenOptions,
  type LumenQuestion,
  type LumenSeedSummary,
  lumenGlossary,
  lumenReference,
  lumenRows,
  PINNED_AS_OF as LUMEN_PINNED_AS_OF,
  parseAsOf as parseLumenAsOf,
  seedDemoCommerce,
  seedLumen,
} from "./commerce";
export { type BenchQuestion, DASHBENCH, NOW } from "./dashbench";
export { type Expectation, GOLDEN, type GoldenQuestion, type Grade, type GradedOutcome, grade } from "./golden";
export { createRandom, type Random } from "./random";
export { gradeRoutine, ROUTINE_CASES, ROUTINE_FIXTURE, type RoutineCase, type RoutineView } from "./routines";
export { generateBilling, type SaasBilling } from "./saas/billing";
export { type DemoPostgresOptions, seedDemoPostgres } from "./saas/demo-postgres";
export { DEMO_GLOSSARY, demoGlossary } from "./saas/glossary";
export { DEMO_GUIDES } from "./saas/guides";
export {
  AS_OF,
  endOfDay,
  generateSaas,
  monthChurn,
  monthMrr,
  mrrAt,
  PLANS,
  type SaasCompany,
  TARGETS,
  yesterdayEnd,
} from "./saas/model";
export { CHURNED_MRR_BY_PLAN_SQL, MRR_SQL } from "./saas/reference";
export { demoRows, grantReader, SAMPLE_DATA_MARKER, type SeedSummary, seedSaas } from "./saas/seed";
export { clickhouseDatabases, grantReaderClickHouse, seedSaasClickHouse } from "./saas/seed-clickhouse";
