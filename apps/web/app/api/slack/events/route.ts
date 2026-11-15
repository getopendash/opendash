import { loggableError, slackRemovedBySlack } from "@opendash/core";
import { envelopeOfRequest, gateSlackEvent, homeOpenedOf, slackRemovalOf, slackSigned } from "@opendash/slack";
import { after } from "next/server";
import { slackDeps } from "@/lib/slack";
import { webhookBot } from "@/lib/slack-bot";

/**
 * Slack's events and button presses over HTTPS (the cloud's way). OpenDash checks Slack's signature itself,
 * so it can read the event first: Slack taking the app back (uninstalled, or its token revoked) is handled here,
 * since Chat SDK ignores it, and a question is recorded before Slack hears it arrived (§4). A question that couldn't
 * be recorded answers 500, so Slack sends it again; a retry or a twin of one recorded already goes no further.
 * Someone opening App Home's tab gets it published for their team, read from the event (Chat SDK's doesn't say).
 * Everything else goes to the bot, which checks the signature again, answers within Slack's 3 seconds and leaves the
 * reply to the worker. Not found where Slack connects over the worker's socket.
 */
export async function POST(request: Request) {
  const bot = webhookBot();
  if (!bot) return new Response("Not found", { status: 404 });
  // Read at most this much before Slack's signature is checked: Slack's own payloads are far smaller.
  const body = await bodyWithin(request, MAX_SLACK_BODY_BYTES);
  if (body === null) return new Response("Payload too large", { status: 413 });
  const signed = slackSigned(
    process.env.SLACK_SIGNING_SECRET?.trim() ?? "",
    {
      timestamp: request.headers.get("x-slack-request-timestamp"),
      signature: request.headers.get("x-slack-signature"),
    },
    body,
  );
  const envelope = signed ? envelopeOfRequest(request.headers.get("content-type"), body) : null;
  if (envelope) {
    const removal = envelope.eventType === "events_api" ? slackRemovalOf(envelope.body) : null;
    if (removal) {
      await slackRemovedBySlack(slackDeps, removal);
      return new Response(null, { status: 200 });
    }
    let verdict: "forward" | "skip";
    try {
      verdict = await gateSlackEvent(slackDeps, envelope);
    } catch (error) {
      console.error(JSON.stringify({ msg: "slack question not recorded", error: loggableError(error) }));
      return new Response(null, { status: 500 });
    }
    if (verdict === "skip") return new Response(null, { status: 200 });
    const home = homeOpenedOf(envelope);
    if (home) {
      after(() =>
        bot
          .home(home.teamId, home.userId)
          .catch((error: unknown) =>
            console.error(JSON.stringify({ msg: "slack home not published", error: loggableError(error) })),
          ),
      );
    }
  }
  const again = new Request(request.url, { method: "POST", headers: request.headers, body });
  return bot.handle(again, (task) => after(() => task));
}

const MAX_SLACK_BODY_BYTES = 1024 * 1024;

/** The request's body as text, or null once it says or turns out to be larger than `max` bytes (it's read no further). */
async function bodyWithin(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
