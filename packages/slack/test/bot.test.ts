// The bot's small parts: the Slack team a message came from, the question without the mention (and the session's title
// from it, as OpenDash names the conversation), a suggested prompt's label cut to fit its button, and the chat client's
// bounds.
import { BUDGETS } from "@opendash/core";
import { describe, expect, it } from "vitest";
import { conversationTitle, promptTitle, questionText, teamOf } from "../src";
import { onlyRateLimits, slackClientOptions } from "../src/bot";

describe("the bot", () => {
  it("bounds each of the chat client's requests, and lets it try again only after a rate limit", () => {
    expect(slackClientOptions.timeout).toBe(BUDGETS.slack.apiMs);
    expect(slackClientOptions.retryConfig.retries).toBe(BUDGETS.slack.rateLimitRetries);
    // Waited out, the client throws a plain error to go again: it does.
    expect(() =>
      onlyRateLimits(new Error("A rate limit was exceeded (url: chat.postMessage, retry-after: 3)")),
    ).not.toThrow();
    // A request that failed or timed out may have posted, and an answer from Slack won't change: they stop here.
    const request = Object.assign(new Error("timeout of 10000ms exceeded"), { code: "slack_webapi_request_error" });
    expect(() => onlyRateLimits(request)).toThrow(request);
    const http = Object.assign(new Error("An HTTP protocol error occurred"), { code: "slack_webapi_http_error" });
    expect(() => onlyRateLimits(http)).toThrow(http);
  });

  it("finds the team in each shape Slack sends it", () => {
    expect(teamOf({ team_id: "T1" })).toBe("T1");
    expect(teamOf({ team: "T2" })).toBe("T2");
    expect(teamOf({ team: { id: "T3" } })).toBe("T3");
    expect(teamOf({ user: { team_id: "T4" } })).toBe("T4");
    expect(teamOf({})).toBeNull();
  });

  it("asks the question without the mention, and names the Slack session as the conversation is named", () => {
    expect(questionText("<@U0BOT> How did MRR change?")).toBe("How did MRR change?");
    expect(questionText("@opendash churn by plan")).toBe("churn by plan");
    expect(conversationTitle("<@U0BOT> How did MRR change?")).toBe("How did MRR change?");
    expect(conversationTitle(`<@U0BOT> ${"word ".repeat(30)}`)).toHaveLength(80);
  });

  it("labels a suggested prompt with the question, cut at a word", () => {
    expect(promptTitle("Orders by status last month")).toBe("Orders by status last month");
    const long = promptTitle("Subscription amount by month this year, by plan and region");
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long).toBe("Subscription amount by month this year,…");
  });
});
