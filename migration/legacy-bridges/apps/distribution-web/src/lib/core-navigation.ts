import { z } from "zod";
import { coreSessionCredentials, trustedDistributionOrigin } from "./auth";

const iconPath = z
  .string()
  .min(1)
  .max(12000)
  .regex(/^[MmLlHhVvCcSsQqTtAaZz0-9., +eE-]+$/);
/** Explicitly versioned core wire contract; no core implementation is imported. */
const coreNavigationSchema = z
  .object({
    version: z.literal(1),
    locale: z.enum(["en", "hi", "te", "kn", "ta", "ml", "gu"]),
    // Optional while older core deployments still return the version 1 shell.
    timezone: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "Invalid profile timezone")
      .optional(),
    label: z.string().min(1).max(200),
    tabs: z
      .array(
        z
          .object({
            key: z.string().min(1).max(40),
            href: z
              .string()
              .max(160)
              .regex(/^\/(?!\/)[a-z0-9/-]*$/),
            label: z.string().min(1).max(200),
            icon: z
              .object({
                viewBox: z.literal("0 0 1000 1000"),
                transform: z.literal("translate(0 1000) scale(1 -1)"),
                on: iconPath,
                off: iconPath,
              })
              .strict(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
export type CoreNavigation = z.infer<typeof coreNavigationSchema>;

/** Never forward credentials to a request-supplied host or follow redirects. */
export async function readCoreNavigation(
  request: Request,
  options: { coreOrigin: string | undefined; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<CoreNavigation | null> {
  const origin = trustedDistributionOrigin(options.coreOrigin);
  const session = coreSessionCredentials(request);
  if (!origin || !session) return null;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, options.timeoutMs ?? 3000);
  });
  try {
    const read = async () => {
      const response = await (options.fetchImpl ?? fetch)(`${origin}/api/v1/navigation`, {
        method: "GET",
        headers: session.headers,
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok || response.redirected) return null;
      const body = await response.text();
      if (body.length > 200000) return null;
      return coreNavigationSchema.parse(JSON.parse(body));
    };
    return await Promise.race([read(), deadline]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
