export const STUDIO_VISUAL_STYLE_POLICY = "sanatana-photoreal-v4" as const;
/** Illustrate the narration continuously, like the reference devotional Shorts, within citation rules. */
export const STUDIO_NARRATIVE_ILLUSTRATION_POLICY = "narrative-storyboard-v3" as const;
export const STUDIO_NARRATIVE_ILLUSTRATION_GUIDANCE =
  "Illustrate the narration continuously, as a visual story told in step with the speech. Plan one scene for every distinct spoken idea, event, character, place, object or metaphor, in spoken order, so a viewer who never saw the speaker still sees the teaching unfold. Keep original speaker footage for the opening seconds so the viewer first meets the speaker, for moments where the speaker's own gesture, demonstration or direct address carries the meaning, and wherever no faithful scene exists for the words. Consecutive scenes may follow one another directly without returning to the speaker between them. Each scene must still depict only what the cited words say: never invent an event, character, dialogue or outcome to make the story flow, and never show a fabricated likeness of a living guru. Give complex sacred scenes enough time to read; a scene may be long when the speech dwells on it. A decorative or doubtful picture is worse than the speaker: leave those words uncovered. Expect the great majority of the excerpt to be illustrated: a teaching of sixty to ninety-five seconds normally yields eight to fourteen scenes, one per spoken idea, so that the speaker is seen mainly at the opening and in the final seconds. Four scenes for a ninety-second story is too few when the words describe people, places and actions throughout.";
/** Bump when the narrative guidance changes, so saved source screenings are planned again. */
export const STUDIO_NARRATIVE_GUIDANCE_VERSION = 3 as const;
export const STUDIO_VIDEO_ILLUSTRATION_POLICY = "source-first-when-explanatory-v1" as const;
export const STUDIO_STORYBOARD_CONTINUITY_POLICY = "source-cued-approved-reference-v4" as const;
export const STUDIO_STORYBOARD_CONTINUITY_GUIDANCE =
  "Treat supporting illustrations as an ordered, source-cued devotional storyboard, not an unrelated image gallery. Let the exact spoken action or idea determine each scene and its timing. Generate exactly one uninterrupted full-frame composition for the currentSceneId and current brief. Other storyboard entries and reference images are context only: never render a storyboard sheet, split screen, stacked panels, before/after comparison, repeated views or an image gallery. Preserve a cohesive visual language: photographic material treatment, palette, lighting, character proportions and culturally appropriate detail. A supplied previous approved illustration is a visual continuity reference, not proof of the current scene's meaning or permission to repeat its action. Preserve recognizable character features and attributes only when the cited words refer to the same figure in the same form and narrative phase. A change of deity, avatar, age, setting or narrative action must follow the current passage; never copy a previous figure's identity or accessories into a different one. Preserve continuity without repeating the same pose or composition mechanically. Track who is already present: an arriving character joins the scene and must not silently replace an existing character. Preserve existing participants and their relative positions unless the source establishes a departure or the brief explicitly uses a tighter view that leaves them outside the frame; never imply an invented exit. Distinguish a newly arriving sage from the elder already giving counsel. Different named characters require clearly distinct faces, age treatment or hair/beard silhouettes; do not clone an existing face and merely change the costume. Recurring characters retain their own established identity. Do not invent connecting events, dialogue or settings to make a story flow. Use one legible focal action per scene, and retain source footage where an illustration would be decorative or cannot be made faithful. Complex sacred scenes need enough time to read; no rapid image changes merely to meet a count. Rejected imagery never becomes a continuity reference.";
export const STUDIO_VIDEO_ILLUSTRATION_GUIDANCE =
  "Original speaker footage is the default. Generated imagery is optional, never a requirement or quota. Return zero illustrations when the original footage communicates the teaching well. Add an image only when it materially helps viewers understand the specific spoken idea; topical decoration, variety and visual beauty alone are insufficient reasons. Preserve the speaker's meaningful gestures, expressions and demonstrations. Explain what each proposed insert clarifies beyond the original picture. If an optional generated image fails review, retain the actual source footage rather than force an image or block an otherwise valid video.";

/** Owner requirement, 29 October 2026: every picture follows Sanatana Dharma norms. */
export const STUDIO_SANATANA_DHARMA_ART_DIRECTION =
  "All imagery follows true Hindu and Sanatana Dharma norms. Depict Hindu deities with their correct traditional iconography, attributes, mounts and companions, serene and respectful, never casual, comic or modernized. Depict people as devotees of Bharat: men and women wear a clear bottu or tilak on the forehead (kumkum, vibhuti or chandan as fits the tradition and the passage) and traditional Hindu attire such as dhoti or panche with angavastram, kurta, saree, pavada or veshti; sages and ascetics wear ochre or white cloth with rudraksha or tulasi beads; married women may wear sindoor, bangles and mangalasutra. Settings are Hindu temples, ashramas, homes with puja rooms and oil lamps, riverbanks, forests, villages and towns of Bharat, with details such as rangoli, tulasi plants, banana leaves, brass and bronze vessels, flowers and incense. Even a modern everyday scene, such as a worker beside a vehicle or a family at a meal, keeps these devotional markers in a natural way. Never use Western or generic international stock-photo styling, Western clothing as the default, or non-Hindu religious symbols. Preserve every rule of sacred iconography and the ban on fabricated guru likenesses.";
/** Shared art direction applies even when a saved preference predates this policy. */
export const STUDIO_VISUAL_ART_DIRECTION = `Use photorealistic devotional imagery with the visual treatment of a carefully lit cinematic photograph, not a devotional calendar painting: believable natural light, lifelike skin and fabric, authentic material textures, realistic depth and coherent anatomy. Keep it sacred, serene, scenic and elegant, with one meaningful focal action. Avoid painted brushwork, airbrushed skin, outlined foliage, cartoons, plastic-looking CGI and exaggerated fantasy effects. When a teaching uses a metaphor such as a fortress or shelter, express it through realistic stone architecture, natural surroundings and composition; do not draw a glowing diagram, neon force field or holographic castle. Sacred symbolism must not turn the whole image into fantasy concept art. The initial brief must explicitly request photographic textures and light. Photorealism describes light and materials, not a change to the subject: retain all required sacred anatomy, multiple arms, attributes and mounts exactly as specified. Never simplify a deity into an ordinary two-armed person to make it photographic. Sacred subjects remain respectful conceptual visualizations with accurate traditional iconography, never fabricated documentary evidence. Never fabricate the likeness of a living guru. Do not add AI-generated labels, generator badges, signatures or watermarks. Keep generated artwork free of typography; the renderer adds only approved channel text, captions and attribution. ${STUDIO_SANATANA_DHARMA_ART_DIRECTION}`;

export const DEFAULT_STUDIO_VISUAL_PREFERENCE =
  "In videos, illustrate the narration scene by scene: deities, sages, devotees and places exactly as the cited words describe them, in photorealistic, sacred, serene and elegant devotional imagery following Sanatana Dharma norms, with people wearing bottu or tilak and traditional Hindu attire. Use nature and scenic imagery such as rivers, forests, mountains, gardens, lotus ponds and dawn light where they express the teaching. Avoid unrelated scenery, generic stock people or objects. Keep the speaker on screen where the words have no faithful scene.";

/** How new videos are presented. Approved files keep the layout they were reviewed with. */
export type StudioPresentationStyle = {
  /** immersive: the picture fills the whole 1080×1920 frame with captions over its lower band. classic: the framed picture with captions below. */
  layout: "immersive" | "classic";
  /** narrative: illustrate the narration continuously. restrained: speaker first, a few inserts. */
  storyboard: "narrative" | "restrained";
  /** batch: scene images through the provider's half-price batch queue (hours). immediate: full price, minutes. */
  imagery: "batch" | "immediate";
};
export const DEFAULT_STUDIO_PRESENTATION_STYLE: Readonly<StudioPresentationStyle> = {
  layout: "immersive",
  storyboard: "narrative",
  imagery: "batch",
};
/**
 * The installation's scene image delivery when Settings has never chosen one. GBADPT keeps the
 * half-price batch queue; an installation that sets `STUDIO_IMAGERY_DEFAULT=immediate` (DP) draws
 * each scene right away until an Admin picks otherwise. Anything else is a configuration error.
 */
export function studioImageryDefault(
  env: Record<string, string | undefined>,
): StudioPresentationStyle["imagery"] {
  const value = env.STUDIO_IMAGERY_DEFAULT?.trim();
  if (value === undefined || value === "") return DEFAULT_STUDIO_PRESENTATION_STYLE.imagery;
  if (value === "batch" || value === "immediate") return value;
  throw Error("INVALID_IMAGERY_DEFAULT");
}
export function studioPresentationStyle(
  value?: unknown,
  defaults?: { imagery?: StudioPresentationStyle["imagery"] },
): StudioPresentationStyle {
  const imagery = defaults?.imagery ?? DEFAULT_STUDIO_PRESENTATION_STYLE.imagery;
  if (value === undefined) return { ...DEFAULT_STUDIO_PRESENTATION_STYLE, imagery };
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !Object.hasOwn(DEFAULT_STUDIO_PRESENTATION_STYLE, key)) ||
    !["immersive", "classic"].includes((value as StudioPresentationStyle).layout) ||
    !["narrative", "restrained"].includes((value as StudioPresentationStyle).storyboard) ||
    ((value as StudioPresentationStyle).imagery !== undefined &&
      !["batch", "immediate"].includes((value as StudioPresentationStyle).imagery))
  )
    throw Error("INVALID_PRESENTATION_STYLE");
  const style = value as StudioPresentationStyle;
  // Settings saved before image delivery existed use the installation's default.
  return {
    layout: style.layout,
    storyboard: style.storyboard,
    imagery: style.imagery ?? imagery,
  };
}

/** Style guides presentation; it never overrides source fidelity or approval requirements. */
export function studioVisualPreference(value?: unknown): string {
  if (value === undefined) return DEFAULT_STUDIO_VISUAL_PREFERENCE;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 1000 ||
    [...value].some((c) => c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0)))
  )
    throw Error("INVALID_VISUAL_PREFERENCE");
  return value.trim();
}
