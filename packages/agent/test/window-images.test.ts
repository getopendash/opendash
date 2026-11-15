// An image the person attached is a picture to the model, not its bytes: the window counts it as one picture's
// tokens, so a conversation with an image isn't folded as if it were megabytes of text.
import { describe, expect, it } from "vitest";
import { tokensOf } from "../src/harness/window";

describe("counting a conversation with an image", () => {
  it("counts the picture, never its base64", () => {
    const data = "A".repeat(700_000);
    const withImage = [
      {
        role: "user",
        content: [
          { type: "image", image: data, mediaType: "image/png" },
          { type: "text", text: "Hi" },
        ],
      },
    ];
    expect(tokensOf(withImage)).toBeLessThan(2_000);
    expect(tokensOf(withImage)).toBeGreaterThan(1_500);
  });
});
