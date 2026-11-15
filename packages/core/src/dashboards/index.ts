/**
 * Apps: drawn by one runtime in a sealed frame from a definition of named queries and filters and the App's
 * own code: their storage and the operations on them, their data path (the catalog their queries are checked against,
 * their compiler, the cache and the queue), and the frame's signed link.
 */

export { type ActionOutcome, type PreparedAction, prepareAction, runAction } from "./actions";
export { type CatalogEntry, dashboardCatalog, type LoadedCatalog, pinsOf, withOwn } from "./catalog";
export { type CompiledQuery, compileQuery, QueryRefused } from "./compile";
export {
  type DashboardAnswer,
  type DashboardRequest,
  dashboardQueryFailed,
  executeDashboardQuery,
  MAX_REQUESTS,
  requestDashboardQueries,
} from "./data";
export { type FrameClaims, readFrameToken, signFrameToken } from "./frame-token";
export { probeOwnDataset } from "./own";
export { queryReads } from "./reads";
export { probeServiceDataset, serviceChanged, serviceGeneration } from "./service";
export {
  ACTIONS_OFF,
  type Actor,
  type AppWork,
  actionsOff,
  baseOf,
  canEditDashboard,
  catalogsFor,
  createDashboard,
  DashboardProblem,
  type DashboardShare,
  type DashboardSummary,
  type DashboardVersionView,
  type DashboardView,
  type DraftUndo,
  type DrawnRevision,
  definitionAt,
  deleteDashboard,
  getDashboard,
  keepWork,
  listDashboards,
  listShares,
  listVersions,
  type PartsBuild,
  type PlannedDashboard,
  parseBase,
  plannedDashboards,
  publishDraft,
  type RenderCheck,
  type RenderFinding,
  renderCheckOf,
  restoreVersion,
  type ShareRole,
  saveDraft,
  saveRenderCheck,
  setDashboardVisibility,
  shareDashboard,
  startDashboard,
  undoable,
  undoRun,
  type WorkingCopy,
  withoutRetiredKeys,
  workingCopy,
} from "./store";
export {
  type Gathered,
  gatherSummary,
  keepSummary,
  SUMMARY_ANGLES,
  type SummaryAngle,
  type SummaryAnswer,
  type SummaryCost,
  type SummarySource,
  strayNumbers,
  summaryAnswer,
  summaryFailed,
  summaryNumbers,
} from "./summary";
export { type RecordWork, readWork, readWorkHistory, setWork, type WorkEvent } from "./work";
