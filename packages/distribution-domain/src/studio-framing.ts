import { STUDIO_FRAME, STUDIO_PICTURE, type StudioPresentationLayout } from "./studio-presentation";

/** The actual sharp source picture, excluding its decorative blurred backdrop.
 * Use the same even pixel dimensions in rendering and review: every source edge
 * remains visible, including side titles and the top of the speaker's head. */
export function studioFullPictureRegion(
  sourceWidth: number,
  sourceHeight: number,
  layout: StudioPresentationLayout = "classic",
) {
  const picture = layout === "immersive" ? STUDIO_FRAME : STUDIO_PICTURE;
  if (
    !Number.isSafeInteger(sourceWidth) ||
    !Number.isSafeInteger(sourceHeight) ||
    sourceWidth < 1 ||
    sourceHeight < 1
  )
    throw Error("STUDIO_MEDIA_DIMENSIONS_INVALID");
  const scale = Math.min(picture.width / sourceWidth, picture.height / sourceHeight);
  const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);
  const width = even(sourceWidth * scale);
  const height = even(sourceHeight * scale);
  return {
    // yuv420p overlay placement is aligned to even pixels too.
    x: picture.x + Math.floor((picture.width - width) / 4) * 2,
    y: picture.y + Math.floor((picture.height - height) / 4) * 2,
    width,
    height,
  };
}
