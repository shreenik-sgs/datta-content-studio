import {
  CONTENT_CATEGORIES,
  DISTRIBUTION_CAPABILITIES,
  DISTRIBUTION_CHANNELS,
  MASTER_MIME_TYPES,
  MAX_ONLINE_MASTER_BYTES,
  validateContentRights,
} from "@satsang/distribution-domain";
import { z } from "zod";

export const distributionCapabilitySchema = z.enum(DISTRIBUTION_CAPABILITIES);
export const distributionChannelSchema = z.enum(DISTRIBUTION_CHANNELS);
export const contentCategorySchema = z.enum(CONTENT_CATEGORIES);
export const distributionLocaleSchema = z.enum(["en", "hi", "te", "kn", "ta", "ml", "gu"]);
export const contentLanguageSchema = z.enum(["en", "hi", "te", "kn", "ta", "ml", "gu", "sa"]);
export const distributionOperatorSchema = z
  .object({
    id: z.string().min(1).max(128),
    roles: z.array(z.string().min(1).max(64)).max(32),
    isTest: z.boolean(),
    locale: distributionLocaleSchema,
  })
  .strict();
const instant = z.string().datetime({ offset: true });
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const territory = z
  .string()
  .regex(
    /^(?:WORLDWIDE|[A-Z]{2})$/,
    "Use WORLDWIDE or two-letter country codes separated by commas, such as IN, US.",
  );
const filename = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      !value.includes("/") &&
      !value.includes("\\") &&
      [...value].every(
        (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ),
  )
  .refine((value) => value !== "." && value !== "..");
export const createContentSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    language: contentLanguageSchema,
    category: contentCategorySchema,
  })
  .strict();
export const updateContentSchema = createContentSchema
  .extend({ expectedRevision: revision })
  .strict();
export const contentRightsSchema = z
  .object({
    owner: z
      .string()
      .trim()
      .min(1, "Enter the rights holder’s name.")
      .max(200, "Rights holder must be 200 characters or fewer."),
    territories: z
      .array(territory)
      .min(1, "Enter WORLDWIDE or comma-separated country codes, such as IN, US.")
      .max(250),
    channels: z
      .array(distributionChannelSchema)
      .min(1, "Select at least one allowed publication channel.")
      .max(DISTRIBUTION_CHANNELS.length),
    authorizationBasis: z
      .string()
      .trim()
      .min(1, "Describe who authorized this use and what permission was granted.")
      .max(2000, "Authorization must be 2,000 characters or fewer."),
    privacyClass: z.enum(["PUBLIC", "INTERNAL", "RESTRICTED"]),
    releaseAt: instant.nullable(),
    expiresAt: instant.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    let explained = false;
    for (const field of ["territories", "channels"] as const) {
      if (new Set(value[field]).size !== value[field].length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `Remove duplicate ${field}.`,
        });
        explained = true;
      }
    }
    if (
      value.releaseAt &&
      value.expiresAt &&
      Date.parse(value.releaseAt) >= Date.parse(value.expiresAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "Expiry must be later than the release date.",
      });
      explained = true;
    }
    try {
      validateContentRights(value);
    } catch {
      if (!explained)
        context.addIssue({ code: z.ZodIssueCode.custom, message: "Check the permission details." });
    }
  });
export const rightsCommandSchema = z
  .object({ expectedRevision: revision, rights: contentRightsSchema })
  .strict();
export const approvalCommandSchema = z.object({ expectedRevision: revision }).strict();
export const withdrawCommandSchema = z.object({ expectedRevision: revision }).strict();
export const exportCommandSchema = z
  .object({ expectedRevision: revision, channel: distributionChannelSchema, territory })
  .strict();
export const contentVersionSchema = z
  .object({
    id: z.string().uuid(),
    masterId: z.string().uuid(),
    number: revision,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteSize: z.number().int().min(1).max(MAX_ONLINE_MASTER_BYTES),
    mimeType: z.enum(MASTER_MIME_TYPES),
    originalName: filename,
    createdAt: instant,
    createdBy: z.string().min(1).max(128),
  })
  .strict();
export const contentApprovalSchema = z
  .object({
    versionId: z.string().uuid(),
    approvedRevision: revision,
    reviewerId: z.string().min(1).max(128),
    approvedAt: instant,
  })
  .strict();
export const contentMasterSchema = z
  .object({
    sourceUrl: z.string().url().optional(),
    id: z.string().uuid(),
    title: z.string().min(1).max(200),
    language: contentLanguageSchema,
    category: contentCategorySchema,
    isTest: z.boolean(),
    revision,
    state: z.enum(["DRAFT", "RIGHTS_CLEARED", "APPROVED", "PUBLISHED", "WITHDRAWN"]),
    currentVersion: contentVersionSchema,
    rights: contentRightsSchema.nullable(),
    approval: contentApprovalSchema.nullable(),
    createdAt: instant,
    updatedAt: instant,
  })
  .strict();
export const contentListSchema = z
  .object({
    version: z.literal(1),
    items: z.array(contentMasterSchema).max(100),
    nextOffset: z.number().int().nonnegative().nullable(),
  })
  .strict();
export const contentListQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
  query: z.string().max(200).default(""),
  view: z.enum(["content", "approvals", "releases"]).default("content"),
  archive: z.enum(["active", "withdrawn", "all"]).default("all"),
});
export const exportManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    exportedAt: instant,
    exportedBy: z.string().min(1).max(128),
    channel: distributionChannelSchema,
    territory,
    content: contentMasterSchema,
  })
  .strict();
export type CreateContentCommand = z.infer<typeof createContentSchema>;
export type UpdateContentCommand = z.infer<typeof updateContentSchema>;
export type RightsCommand = z.infer<typeof rightsCommandSchema>;
export type ApprovalCommand = z.infer<typeof approvalCommandSchema>;
export type WithdrawCommand = z.infer<typeof withdrawCommandSchema>;
export type ExportCommand = z.infer<typeof exportCommandSchema>;
export type ExportManifest = z.infer<typeof exportManifestSchema>;
