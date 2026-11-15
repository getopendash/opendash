/**
 * Routines for the web's client components (`@opendash/core/routines`): the spec, the schedule, the sentence and how a
 * metric's values show. They import only zod and each other, so the composer checks a routine and shows its next
 * times, its sentence and its line as it's made, the way the store will. Nothing here reads the database.
 */
export { displayMetric, type MetricFormat } from "../answer/format";
export {
  draftOf,
  draftProblem,
  emptyDraft,
  lineText,
  parseLine,
  type Repeats,
  type RoutineDraft,
  specOf,
} from "./draft";
export {
  addPeriods,
  CHECK_HOUR,
  type CheckGrain,
  checkHourFrom,
  isTimeZone,
  lastWholePeriod,
  latestOccurrence,
  localDate,
  nextCheckAt,
  nextLocalTime,
  nextOccurrence,
  periodStart,
  ROUNDUP_AT,
} from "./schedule";
export {
  destinationWords,
  listWords,
  routineSentence,
  ruleWords,
  type SentenceNames,
  type SentencePart,
  sentenceText,
} from "./sentence";
export {
  asksOpenDash,
  Condition,
  FoundSpec,
  MAX_WATCHED_METRICS,
  needsManager,
  ROUTINE_SPEC_VERSION,
  RoutineSpec,
  ScheduledAction,
  ScheduleRule,
  ScheduleSpec,
  SENSITIVITY,
  type Sensitivity,
  SlackDestination,
  specProblem,
  VIEWERS_DONT_ASK,
  WATCHING_KEY,
  WEEKDAYS,
  type Weekday,
} from "./spec";
