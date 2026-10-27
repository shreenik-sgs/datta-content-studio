import { expect, it } from "vitest";
import { studioFullPictureRegion } from "./studio-framing";
import { STUDIO_PICTURE } from "./studio-presentation";

it("keeps landscape title edges and tall source heads inside one centered complete picture", () => {
  expect(studioFullPictureRegion(1920, 1080)).toEqual({
    x: 0,
    y: 408,
    width: 1080,
    height: 606,
  });
  expect(studioFullPictureRegion(360, 1280)).toEqual({
    x: 360,
    y: 72,
    width: 360,
    height: 1280,
  });
  for (const [width, height] of [
    [1920, 1080],
    [1080, 1920],
    [641, 361],
    [361, 641],
  ] as const) {
    const fit = studioFullPictureRegion(width, height);
    expect(fit.x).toBeGreaterThanOrEqual(STUDIO_PICTURE.x);
    expect(fit.y).toBeGreaterThanOrEqual(STUDIO_PICTURE.y);
    expect(fit.x + fit.width).toBeLessThanOrEqual(STUDIO_PICTURE.x + STUDIO_PICTURE.width);
    expect(fit.y + fit.height).toBeLessThanOrEqual(STUDIO_PICTURE.y + STUDIO_PICTURE.height);
    expect(Object.values(fit).every((n) => Number.isInteger(n) && n % 2 === 0)).toBe(true);
    expect(Math.abs(fit.width / fit.height - width / height)).toBeLessThan(0.006);
  }
});

it.each([
  [0, 720],
  [1280, -1],
  [Number.NaN, 1080],
  [1920, Number.POSITIVE_INFINITY],
  [640.5, 360],
])("rejects unknown source geometry (%s, %s)", (width, height) => {
  expect(() => studioFullPictureRegion(width, height)).toThrow("STUDIO_MEDIA_DIMENSIONS_INVALID");
});
