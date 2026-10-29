import { randomUUID } from "node:crypto";
import {
  type StudioProviderConfig,
  type StudioProviderCredential,
  loadStudioProviderConfig,
  saveStudioSettings,
  studioProviderAccountBlock,
  studioSettingsPath,
  studioSettingsRevision,
} from "@satsang/distribution-db";
import {
  MAX_MASTER_BYTES,
  STUDIO_CHANNELS,
  studioAppLinks,
  studioDefaultAccount,
  studioPresentationStyle,
  studioVisualPreference,
  studioYoutubeClosing,
} from "@satsang/distribution-domain";
import { z } from "zod";
import { json, readBoundedBody } from "../../../lib/http";
import { access } from "../../../lib/runtime";
import { studioRepository } from "../../../lib/studio-runtime";

const identifier = z.string().regex(/^[A-Za-z0-9_.:@-]{1,160}$/);
const secret = z
  .string()
  .max(8192)
  .refine((v) => !/[\r\n]/.test(v));
const accountSchema = z
  .object({
    id: identifier.optional(),
    label: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine((v) => ![...v].some((c) => c.charCodeAt(0) < 32))
      .optional(),
    isDefault: z.boolean().optional(),
    platform: z.enum(STUDIO_CHANNELS).refine((v) => v !== "website"),
    providerAccountId: identifier,
    enabled: z.boolean(),
    eligibilityVerified: z.boolean(),
    accessToken: secret.optional(),
    webhookAppSecret: secret.optional(),
    webhookVerifyToken: secret.optional(),
    defaults: z
      .object({
        youtube: z
          .object({
            privacy: z.enum(["public", "unlisted", "private"]),
            madeForKids: z.boolean(),
            isAiGenerated: z.boolean(),
            categoryId: z.string().regex(/^\d{1,2}$/),
          })
          .strict()
          .optional(),
        tiktok: z
          .object({ automaticPostingVerified: z.boolean(), isAiGenerated: z.boolean() })
          .strict()
          .optional(),
        pinterest: z.object({ boardServiceId: identifier }).strict().optional(),
        reddit: z
          .object({
            userAgent: z
              .string()
              .min(1)
              .max(200)
              .refine((v) => !/[\r\n]/.test(v)),
          })
          .strict()
          .optional(),
        whatsapp: z
          .object({
            businessAccountId: z.string().regex(/^\d{5,30}$/),
            templateName: z.string().regex(/^[a-z0-9_]{1,512}$/),
            languageCode: z.string().regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/),
            recipientMode: z.literal("opted_in"),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const commandSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("youtube-target"),
      expectedRevision: z.string().length(64),
      label: z.string().trim().min(1).max(80),
      url: z.string().max(2048),
    })
    .strict(),
  z
    .object({
      action: z.literal("app-links"),
      expectedRevision: z.string().length(64),
      appLinks: z
        .object({
          web: z.string().min(1).max(2048),
          ios: z.string().max(2048),
          android: z.string().max(2048),
        })
        .strict()
        .refine(
          (value) => {
            try {
              studioAppLinks(value);
              return true;
            } catch {
              return false;
            }
          },
          { message: "Use official HTTPS website and app-store destinations" },
        ),
    })
    .strict(),
  z
    .object({
      action: z.literal("visuals"),
      expectedRevision: z.string().length(64),
      visualPreference: z.string().trim().min(1).max(1000),
      layout: z.enum(["immersive", "classic"]).optional(),
      storyboard: z.enum(["narrative", "restrained"]).optional(),
      imagery: z.enum(["batch", "immediate"]).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("retire-lesson"),
      expectedRevision: z.string().length(64),
      id: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("uploads"),
      expectedRevision: z.string().length(64),
      maxMasterUploadMb: z
        .number()
        .int()
        .min(1)
        .max(MAX_MASTER_BYTES / 1024 / 1024),
    })
    .strict(),
  z
    .object({
      action: z.literal("account"),
      expectedRevision: z.string().length(64),
      account: accountSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal("disconnect"),
      expectedRevision: z.string().length(64),
      platform: z.enum(STUDIO_CHANNELS),
      accountId: identifier.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("default-account"),
      expectedRevision: z.string().length(64),
      accountId: identifier,
    })
    .strict(),
  z
    .object({
      action: z.literal("media"),
      expectedRevision: z.string().length(64),
      trustedMediaOrigins: z.array(z.string().max(2048)).max(20),
    })
    .strict(),
]);
function projection(config: StudioProviderConfig, isTest: boolean) {
  return {
    revision: studioSettingsRevision(config),
    visualPreference: studioVisualPreference(config.visualPreference),
    presentation: studioPresentationStyle(config.presentation),
    appLinks: studioAppLinks(config.appLinks),
    maxMasterUploadMb: config.maxMasterUploadMb ?? MAX_MASTER_BYTES / 1024 / 1024,
    maxMasterUploadCapacityMb: MAX_MASTER_BYTES / 1024 / 1024,
    isTest,
    writable:
      !!studioSettingsPath(process.env, isTest) &&
      /^[a-f0-9]{64}$/i.test(process.env.STUDIO_CHANNEL_CONFIG_KEY ?? ""),
    trustedMediaOrigins: config.trustedMediaOrigins,
    accounts: config.accounts.map((account) => {
      const defaults = accountSchema.shape.defaults.safeParse(account.defaults);
      return {
        id: account.id,
        label: account.label ?? account.providerAccountId,
        isDefault: studioDefaultAccount(config.accounts, account.platform)?.id === account.id,
        platform: account.platform,
        transport: account.transport,
        providerAccountId: account.providerAccountId,
        enabled: account.enabled,
        eligibilityVerified: account.eligibilityVerified,
        defaults: defaults.success ? defaults.data : {},
        hasToken: !!account.accessToken,
        connectionPending: account.connectionPending === true,
        channelUrl: account.channelUrl,
        hasWebhookAppSecret: !!account.webhookAppSecret,
        hasWebhookVerifyToken: !!account.webhookVerifyToken,
        blocker: studioProviderAccountBlock(account),
      };
    }),
    runtime: {
      generationEnabled: process.env.STUDIO_GENERATION_ENABLED === "true",
      publishingEnabled: process.env.STUDIO_PUBLISHING_ENABLED === "true",
      transcription: process.env.STUDIO_TRANSCRIPTION_PROVIDER ?? "Not configured",
      drafting: process.env.STUDIO_INTELLIGENCE_PROVIDER ?? "Not configured",
    },
  };
}
export async function GET(request: Request) {
  const auth = await access(request, "operations.manage");
  if (!auth.ok) return auth.response;
  try {
    return json({
      ...projection(
        await loadStudioProviderConfig(studioSettingsPath(process.env, auth.context.isTest)),
        auth.context.isTest,
      ),
      visualLessons: await studioRepository().listVisualLessons(auth.context.isTest, "ALL"),
    });
  } catch {
    return json(
      { error: "Settings storage is unavailable. No credentials have been exposed." },
      503,
    );
  }
}
export async function POST(request: Request) {
  const auth = await access(request, "operations.manage");
  if (!auth.ok) return auth.response;
  try {
    const command = commandSchema.parse(
      JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 32768))),
    );
    const path = studioSettingsPath(process.env, auth.context.isTest);
    const config = await loadStudioProviderConfig(path);
    if (command.action === "retire-lesson") {
      if (studioSettingsRevision(config) !== command.expectedRevision)
        return json({ error: "SETTINGS_CHANGED" }, 409);
      await studioRepository().retireVisualLesson(auth.context, command.id);
      return json({
        ...projection(config, auth.context.isTest),
        visualLessons: await studioRepository().listVisualLessons(auth.context.isTest, "ALL"),
      });
    }
    if (command.action === "youtube-target") {
      const target = studioYoutubeClosing({ label: command.label, url: command.url });
      if (config.accounts.some((a) => a.platform === "youtube" && a.channelUrl === target.url))
        return json(
          { error: "This YouTube destination is already saved. Select it from Saved account." },
          400,
        );
      config.accounts.push({
        id: randomUUID(),
        label: target.label,
        channelUrl: target.url,
        platform: "youtube",
        transport: "buffer",
        world: "PRODUCTION",
        providerAccountId: "",
        accessToken: "",
        enabled: false,
        eligibilityVerified: false,
        connectionPending: true,
        isDefault: !studioDefaultAccount(config.accounts, "youtube"),
      });
    } else if (command.action === "app-links") {
      config.appLinks = studioAppLinks(command.appLinks);
    } else if (command.action === "uploads") config.maxMasterUploadMb = command.maxMasterUploadMb;
    else if (command.action === "visuals") {
      config.visualPreference = studioVisualPreference(command.visualPreference);
      if (command.layout || command.storyboard || command.imagery) {
        const current = studioPresentationStyle(config.presentation);
        config.presentation = studioPresentationStyle({
          layout: command.layout ?? current.layout,
          storyboard: command.storyboard ?? current.storyboard,
          imagery: command.imagery ?? current.imagery,
        });
      }
    } else if (command.action === "media") config.trustedMediaOrigins = command.trustedMediaOrigins;
    else if (command.action === "default-account") {
      const selected = config.accounts.find((a) => a.id === command.accountId);
      if (!selected) return json({ error: "ACCOUNT_NOT_FOUND" }, 400);
      config.accounts = config.accounts.map((a) =>
        a.platform === selected.platform ? { ...a, isDefault: a.id === selected.id } : a,
      );
    } else if (command.action === "disconnect") {
      const candidates = config.accounts.filter((a) => a.platform === command.platform);
      const selected = command.accountId
        ? candidates.find((a) => a.id === command.accountId)
        : candidates.length === 1
          ? candidates[0]
          : undefined;
      if (!selected) return json({ error: "ACCOUNT_NOT_FOUND" }, 400);
      if (
        candidates.length > 1 &&
        studioDefaultAccount(candidates, selected.platform)?.id === selected.id
      )
        return json({ error: "SELECT_REPLACEMENT_DEFAULT" }, 400);
      config.accounts = config.accounts.filter((a) => a.id !== selected.id);
    } else {
      const incoming = command.account;
      const old = incoming.id
        ? config.accounts.find((a) => a.id === incoming.id && a.platform === incoming.platform)
        : config.accounts.find(
            (a) =>
              a.platform === incoming.platform &&
              a.providerAccountId === incoming.providerAccountId,
          );
      if (incoming.id && !old) return json({ error: "ACCOUNT_NOT_FOUND" }, 400);
      if (old && !old.connectionPending && old.providerAccountId !== incoming.providerAccountId)
        return json({ error: "ACCOUNT_DESTINATION_IMMUTABLE" }, 400);
      if (
        config.accounts.some(
          (a) =>
            a.id !== old?.id &&
            a.platform === incoming.platform &&
            a.providerAccountId === incoming.providerAccountId,
        )
      )
        return json({ error: "ACCOUNT_ALREADY_CONFIGURED" }, 400);
      const previousDefault = studioDefaultAccount(config.accounts, incoming.platform);
      const isDefault =
        incoming.isDefault === true || previousDefault?.id === old?.id || !previousDefault;
      const accessToken = incoming.accessToken?.trim() || old?.accessToken;
      if (!accessToken)
        return json({ error: "Enter the provider token to save this connection." }, 400);
      const account: StudioProviderCredential = JSON.parse(
        JSON.stringify({
          ...incoming,
          platform: incoming.platform,
          id: old?.id ?? randomUUID(),
          label: incoming.label ?? old?.label ?? incoming.providerAccountId,
          isDefault,
          world: "PRODUCTION" as const,
          transport:
            incoming.platform === "whatsapp"
              ? ("whatsapp" as const)
              : incoming.platform === "reddit"
                ? ("reddit" as const)
                : incoming.platform === "telegram"
                  ? ("telegram" as const)
                  : ("buffer" as const),
          accessToken,
          connectionPending: false,
          ...(old?.channelUrl ? { channelUrl: old.channelUrl } : {}),
          ...(incoming.webhookAppSecret?.trim() || old?.webhookAppSecret
            ? { webhookAppSecret: incoming.webhookAppSecret?.trim() || old?.webhookAppSecret }
            : {}),
          ...(incoming.webhookVerifyToken?.trim() || old?.webhookVerifyToken
            ? { webhookVerifyToken: incoming.webhookVerifyToken?.trim() || old?.webhookVerifyToken }
            : {}),
        }),
      );
      if (account.enabled) {
        const block = studioProviderAccountBlock(account);
        if (block) return json({ error: block }, 400);
      }
      config.accounts = [
        ...config.accounts
          .filter((a) => a.id !== account.id)
          .map((a) =>
            a.platform === account.platform
              ? { ...a, isDefault: isDefault ? false : a.id === previousDefault?.id }
              : a,
          ),
        account,
      ];
    }
    await saveStudioSettings({
      path,
      key: process.env.STUDIO_CHANNEL_CONFIG_KEY,
      expectedRevision: command.expectedRevision,
      config,
    });
    return json(projection(config, auth.context.isTest));
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    return json(
      {
        error: ["SETTINGS_CHANGED", "SETTINGS_BUSY", "SETTINGS_STORAGE_NOT_CONFIGURED"].includes(
          code,
        )
          ? code
          : "Settings could not be saved. Check the fields and refresh before retrying.",
      },
      code === "SETTINGS_CHANGED" || code === "SETTINGS_BUSY" ? 409 : 400,
    );
  }
}
