// Unsubscribe: a token names one routine to take one person off, signed so that only this
// deployment's links work.
import { uuidv7 } from "@opendash/db";
import { describe, expect, it } from "vitest";
import { readUnsubscribeToken, unsubscribeToken } from "../src/delivery/unsubscribe";

const secret = "a test secret that is long enough";
const target = { orgId: uuidv7(), userId: uuidv7(), routineId: uuidv7() };

describe("unsubscribe tokens", () => {
  it("read back what they were made for", () => {
    expect(readUnsubscribeToken(secret, unsubscribeToken(secret, target))).toEqual(target);
  });

  it("refuse another secret, a changed body, and junk", () => {
    const token = unsubscribeToken(secret, target);
    expect(readUnsubscribeToken("another secret", token)).toBeNull();
    const [body, mac] = token.split(".");
    const forged = Buffer.from(JSON.stringify([uuidv7(), target.userId, target.routineId])).toString("base64url");
    expect(readUnsubscribeToken(secret, `${forged}.${mac}`)).toBeNull();
    expect(readUnsubscribeToken(secret, `${body}.`)).toBeNull();
    expect(readUnsubscribeToken(secret, "x.y.z")).toBeNull();
    expect(readUnsubscribeToken(secret, "")).toBeNull();
    // A body that isn't three ids, signed or not, names nothing.
    const short = Buffer.from(JSON.stringify([target.orgId, target.userId])).toString("base64url");
    expect(readUnsubscribeToken(secret, `${short}.${mac}`)).toBeNull();
  });
});
