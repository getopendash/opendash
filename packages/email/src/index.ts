export { type AuthEmailData, type AuthEmailKind, authEmail } from "./auth-emails";
export { type DigestData, digestEmail } from "./digest-email";
export { assertWebUrl, type EmailContent, escapeHtml, type RenderedEmail, renderEmail, supportAddress } from "./layout";
export {
  EmailError,
  type EmailMessage,
  type EmailOutcome,
  type EmailSender,
  emailLinkOrigin,
  isUndeliverable,
  resendOutcome,
  resendSender,
} from "./resend";
export {
  type AnswerEmailData,
  type FindingItem,
  type FindingsEmailData,
  type PausedEmailData,
  type RoutineEmailData,
  type RoutineFooter,
  routineEmail,
  routineFooter,
} from "./routine-email";
export { emailSenderFromEnv } from "./sender";
export { type SmtpTimeouts, type SmtpTransport, smtpOutcome, smtpSender, smtpTransport } from "./smtp";
