import { STUDIO_PICTURE } from "./studio-presentation";

/** The actual sharp source picture, excluding its decorative blurred backdrop.
 * Use the same even pixel dimensions in rendering and review: every source edge
 * remains visible, including side titles and the top of the speaker's head. */
export function studioFullPictureRegion(sourceWidth: number, sourceHeight: number) {
  if (
    !Number.isSafeInteger(sourceWidth) ||
    !Number.isSafeInteger(sourceHeight) ||
    sourceWidth < 1 ||
    sourceHeight < 1
  )
    throw Error("STUDIO_MEDIA_DIMENSIONS_INVALID");
  const scale = Math.min(STUDIO_PICTURE.width / sourceWidth, STUDIO_PICTURE.height / sourceHeight);
  const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);
  const width = even(sourceWidth * scale);
  const height = even(sourceHeight * scale);
  return {
    // yuv420p overlay placement is aligned to even pixels too.
    x: STUDIO_PICTURE.x + Math.floor((STUDIO_PICTURE.width - width) / 4) * 2,
    y: STUDIO_PICTURE.y + Math.floor((STUDIO_PICTURE.height - height) / 4) * 2,
    width,
    height,
  };
}
