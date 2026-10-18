import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import {
  MAX_MASTER_BYTES,
  STUDIO_CHANNELS,
  type StudioAppLinks,
  type StudioChannel,
  type StudioReadiness,
  studioAppLinks,
  studioChannelLabel,
  studioDefaultAccount,
  studioVisualPreference,
} from "@satsang/distribution-domain";

export type StudioPlatform = Exclude<StudioChannel, "website">;
export type StudioProviderAccount = {
  id: string;
  label?: string;
  isDefault?: boolean;
  platform: StudioPlatform;
  transport: "buffer" | "reddit" | "telegram" | "whatsapp";
  providerAccountId: string;
  world: "PRODUCTION";
  enabled: boolean;
  eligibilityVerified: boolean;
  defaults?: {
    youtube?: {
      privacy: "public" | "unlisted" | "private";
      madeForKids: boolean;
      isAiGenerated: boolean;
      categoryId: string;
    };
    tiktok?: { automaticPostingVerified: boolean; isAiGenerated: boolean };
    pinterest?: { boardServiceId: string };
    reddit?: { userAgent: string };
    whatsapp?: {
      businessAccountId: string;
      templateName: string;
      languageCode: string;
      recipientMode: "opted_in";
    };
  };
};
export type StudioProviderCredential = StudioProviderAccount & {
  accessToken: string;
  webhookAppSecret?: string;
  webhookVerifyToken?: string;
};
export type StudioProviderConfig = {
  version: 1;
  maxMasterUploadMb?: number;
  visualPreference?: string;
  appLinks?: StudioAppLinks;
  accounts: StudioProviderCredential[];
  trustedMediaOrigins: string[];
};
const id = (x: unknown): x is string =>
  typeof x === "string" && /^[A-Za-z0-9_.:@-]{1,160}$/.test(x) && !/[\r\n]/.test(x);
const record = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
export function studioProviderAccountBlock(account: StudioProviderAccount): string | null {
  if (
    !id(account.id) ||
    !id(account.providerAccountId) ||
    account.world !== "PRODUCTION" ||
    !STUDIO_CHANNELS.includes(account.platform) ||
    (account.platform as string) === "website"
  )
    return "INVALID_ACCOUNT";
  if (account.platform === "whatsapp") return "WHATSAPP_RECIPIENT_DELIVERY_NOT_CONFIGURED";
  if (!account.enabled) return "CHANNEL_DISABLED";
  if (!account.eligibilityVerified) return "ACCOUNT_ELIGIBILITY_REQUIRED";
  if (
    account.transport !==
    (account.platform === "reddit"
      ? "reddit"
      : account.platform === "telegram"
        ? "telegram"
        : "buffer")
  )
    return "UNSUPPORTED_TRANSPORT";
  const defaults = account.defaults;
  if (
    account.platform === "youtube" &&
    (!defaults?.youtube ||
      !["public", "unlisted", "private"].includes(defaults.youtube.privacy) ||
      typeof defaults.youtube.madeForKids !== "boolean" ||
      typeof defaults.youtube.isAiGenerated !== "boolean" ||
      !/^(1|2|10|15|17|19|20|22|23|24|25|26|27|28|29)$/.test(defaults.youtube.categoryId) ||
      /[\r\n]/.test(defaults.youtube.categoryId))
  )
    return "YOUTUBE_PUBLISH_SETTINGS_REQUIRED";
  if (
    account.platform === "tiktok" &&
    (defaults?.tiktok?.automaticPostingVerified !== true ||
      typeof defaults.tiktok.isAiGenerated !== "boolean")
  )
    return "TIKTOK_AUTOMATIC_ELIGIBILITY_REQUIRED";
  if (account.platform === "pinterest" && !id(defaults?.pinterest?.boardServiceId))
    return "PINTEREST_BOARD_REQUIRED";
  if (
    account.platform === "reddit" &&
    (!/^[A-Za-z0-9_]{2,21}$/.test(account.providerAccountId) ||
      /[\r\n]/.test(account.providerAccountId) ||
      !defaults?.reddit?.userAgent ||
      defaults.reddit.userAgent.length > 200 ||
      /[\r\n]/.test(defaults.reddit.userAgent))
  )
    return "REDDIT_DESTINATION_REQUIRED";
  if (
    account.platform === "telegram" &&
    !/^(@[A-Za-z][A-Za-z0-9_]{4,31}|-100[0-9]{5,16})$/.test(account.providerAccountId)
  )
    return "TELEGRAM_CHANNEL_REQUIRED";
  return null;
}

/** Only this projection may be returned to a browser. Configuration is not a live token check. */
export function studioProviderReadiness(
  config: StudioProviderConfig,
  isTest: boolean,
): StudioReadiness["channels"] {
  return STUDIO_CHANNELS.filter((channel) => channel !== "website").map((channel) => {
    const account = studioDefaultAccount(config.accounts, channel);
    const reason = isTest
      ? "TEST_NETWORK_DISABLED"
      : !account
        ? "CHANNEL_NOT_CONNECTED"
        : studioProviderAccountBlock(account);
    return {
      channel,
      label: studioChannelLabel(channel),
      ready: reason === null,
      reason,
      accountId: account?.id ?? null,
      accounts: config.accounts
        .filter((candidate) => candidate.platform === channel)
        .map((candidate) => {
          const reason = isTest ? "TEST_NETWORK_DISABLED" : studioProviderAccountBlock(candidate);
          return {
            id: candidate.id,
            label: candidate.label ?? `${studioChannelLabel(channel)} (${candidate.id})`,
            isDefault: candidate.id === account?.id,
            ready: reason === null,
            reason,
            ...(candidate.platform === "youtube" && candidate.defaults?.youtube
              ? { privacy: candidate.defaults.youtube.privacy }
              : {}),
          };
        }),
      transport:
        account?.transport ??
        (channel === "whatsapp"
          ? "whatsapp"
          : channel === "reddit"
            ? "reddit"
            : channel === "telegram"
              ? "telegram"
              : "buffer"),
    };
  });
}

/** No credentials, paths, or provider error bodies are included in thrown errors. */
export async function loadStudioProviderConfig(
  path?: string,
  key = process.env.STUDIO_CHANNEL_CONFIG_KEY,
): Promise<StudioProviderConfig> {
  if (path === "database:test" || path === "database:production") {
    const { loadDatabaseStudioSettings } = await import("./studio-settings-database");
    return loadDatabaseStudioSettings(path === "database:test", process.env, key);
  }
  if (!path) return { version: 1, accounts: [], trustedMediaOrigins: [] };
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!isAbsolute(path)) throw new Error();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 64 * 1024 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error();
    return parseStudioProviderConfig(JSON.parse(await handle.readFile("utf8")), key);
  } catch {
    throw new Error("STUDIO_PROVIDER_CONFIG_INVALID");
  } finally {
    await handle?.close();
  }
}

export function parseStudioProviderConfig(value: unknown, key?: string): StudioProviderConfig {
  let raw = value;
  try {
    if (record(raw) && raw.sealed === 1) {
      if (
        !key ||
        !/^[a-f0-9]{64}$/i.test(key) ||
        typeof raw.iv !== "string" ||
        typeof raw.tag !== "string" ||
        typeof raw.data !== "string"
      )
        throw new Error();
      const decipher = createDecipheriv(
        "aes-256-gcm",
        Buffer.from(key, "hex"),
        Buffer.from(raw.iv, "base64"),
      );
      decipher.setAAD(Buffer.from("sgs-studio-channel-config-v1"));
      decipher.setAuthTag(Buffer.from(raw.tag, "base64"));
      raw = JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(raw.data, "base64")),
          decipher.final(),
        ]).toString("utf8"),
      );
    }
    if (
      !record(raw) ||
      raw.version !== 1 ||
      !Array.isArray(raw.accounts) ||
      raw.accounts.length > 100 ||
      !Array.isArray(raw.trustedMediaOrigins) ||
      raw.trustedMediaOrigins.length > 20 ||
      (raw.maxMasterUploadMb !== undefined &&
        (!Number.isInteger(raw.maxMasterUploadMb) ||
          Number(raw.maxMasterUploadMb) < 1 ||
          Number(raw.maxMasterUploadMb) > MAX_MASTER_BYTES / 1024 / 1024))
    )
      throw new Error();
    if (raw.appLinks !== undefined) {
      if (!record(raw.appLinks)) throw Error("STUDIO_APP_DOWNLOAD_URL_INVALID");
      studioAppLinks(raw.appLinks);
    }
    if (raw.visualPreference !== undefined) studioVisualPreference(raw.visualPreference);
    const defaults = new Set<string>();
    const destinations = new Set<string>();
    const ids = new Set<string>();
    for (const account of raw.accounts) {
      if (
        !record(account) ||
        !id(account.id) ||
        !id(account.providerAccountId) ||
        typeof account.platform !== "string" ||
        !STUDIO_CHANNELS.includes(account.platform as StudioChannel) ||
        account.platform === "website" ||
        account.world !== "PRODUCTION" ||
        !["buffer", "reddit", "telegram", "whatsapp"].includes(String(account.transport)) ||
        typeof account.enabled !== "boolean" ||
        typeof account.eligibilityVerified !== "boolean" ||
        typeof account.accessToken !== "string" ||
        !account.accessToken.trim() ||
        account.accessToken.length > 8192 ||
        /[\r\n]/.test(account.accessToken) ||
        (account.label !== undefined &&
          (typeof account.label !== "string" ||
            !account.label.trim() ||
            account.label.length > 120 ||
            [...account.label].some((c) => c.charCodeAt(0) < 32))) ||
        (account.isDefault !== undefined && typeof account.isDefault !== "boolean") ||
        (account.isDefault === true && defaults.has(account.platform)) ||
        destinations.has(`${account.platform}:${account.providerAccountId}`) ||
        ids.has(account.id)
      )
        throw new Error();
      if (account.defaults !== undefined && !record(account.defaults)) throw new Error();
      if (account.isDefault === true) defaults.add(account.platform);
      destinations.add(`${account.platform}:${account.providerAccountId}`);
      ids.add(account.id);
    }
    for (const platform of STUDIO_CHANNELS) {
      if (
        raw.accounts.filter((account) => account.platform === platform).length > 1 &&
        !defaults.has(platform)
      )
        throw new Error();
    }
    for (const origin of raw.trustedMediaOrigins) {
      if (typeof origin !== "string") throw new Error();
      const url = new URL(origin);
      if (
        url.protocol !== "https:" ||
        url.origin !== origin ||
        url.username ||
        url.password ||
        url.hostname === "localhost" ||
        url.hostname.endsWith(".local") ||
        isIP(url.hostname.replace(/^\[|\]$/g, ""))
      )
        throw new Error();
    }
    return raw as StudioProviderConfig;
  } catch {
    throw Error("STUDIO_PROVIDER_CONFIG_INVALID");
  }
}

export function sealStudioProviderConfig(config: StudioProviderConfig, key: string): string {
  if (!/^[a-f0-9]{64}$/i.test(key)) throw Error("SETTINGS_STORAGE_NOT_CONFIGURED");
  parseStudioProviderConfig(config);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
  cipher.setAAD(Buffer.from("sgs-studio-channel-config-v1"));
  const data = Buffer.concat([cipher.update(JSON.stringify(config), "utf8"), cipher.final()]);
  const sealed = JSON.stringify({
    sealed: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  });
  if (Buffer.byteLength(sealed) > 65536) throw Error("STUDIO_PROVIDER_CONFIG_INVALID");
  return sealed;
}
