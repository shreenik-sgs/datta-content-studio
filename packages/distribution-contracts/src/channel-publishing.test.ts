import { describe, expect, it } from "vitest";
import {
  channelAdoptionSchema,
  telegramChannelPostSchema,
  youtubePublicationMetadataSchema,
} from "./channel-publishing";
describe("channel input contracts", () => {
  it("accepts only numeric channel destinations and plain bounded text", () => {
    expect(
      telegramChannelPostSchema.safeParse({ destination: "-100123", text: "Synthetic example" })
        .success,
    ).toBe(true);
    for (const value of [
      { destination: "123", text: "Direct" },
      { destination: "@unverified", text: "Example" },
      { destination: "-100123", text: "a".repeat(4097) },
      { destination: "-100123", text: "Text", parse_mode: "HTML" },
    ])
      expect(telegramChannelPostSchema.safeParse(value).success).toBe(false);
  });
  it("requires explicit privacy and synthetic-media decisions without defaulting a release", () => {
    const value = {
      title: "Synthetic fixture",
      description: "Example",
      categoryId: "22",
      language: "te",
      visibility: "private",
      madeForKids: false,
      containsSyntheticMedia: false,
    };
    expect(youtubePublicationMetadataSchema.safeParse(value).success).toBe(true);
    expect(
      youtubePublicationMetadataSchema.safeParse({ ...value, visibility: undefined }).success,
    ).toBe(false);
    expect(
      youtubePublicationMetadataSchema.safeParse({ ...value, containsSyntheticMedia: undefined })
        .success,
    ).toBe(false);
    expect(
      youtubePublicationMetadataSchema.safeParse({ ...value, notifySubscribers: true }).success,
    ).toBe(false);
    expect(channelAdoptionSchema.safeParse({ channel: "youtube", enabled: true }).success).toBe(
      false,
    );
  });
});
