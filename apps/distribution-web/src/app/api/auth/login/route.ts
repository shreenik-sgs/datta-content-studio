import { loginStudioOperator } from "@satsang/distribution-db";
import { NextResponse } from "next/server";
import {
  STUDIO_SESSION_COOKIE,
  distributionHubPolicyEnabled,
  localStudioLoginAliases,
  studioLoginIdentifier,
  trustedDistributionOrigin,
  validStudioMutationOrigin,
} from "../../../../lib/auth";
import { readBoundedBody } from "../../../../lib/http";
export async function POST(request: Request) {
  if (!validStudioMutationOrigin(request)) return new Response("Invalid origin", { status: 403 });
  if (!(await distributionHubPolicyEnabled())) return new Response("Unavailable", { status: 404 });
  const origin = trustedDistributionOrigin(process.env.DISTRIBUTION_APP_ORIGIN);
  if (!origin) return new Response("Unavailable", { status: 503 });
  try {
    const body = new TextDecoder().decode(await readBoundedBody(request, 4096));
    if (body.length > 4096) return new Response("Invalid request", { status: 413 });
    const data = new URLSearchParams(body);
    const token = await loginStudioOperator(
      studioLoginIdentifier(data.get("email") ?? "", localStudioLoginAliases()),
      data.get("password") ?? "",
      process.env.DISTRIBUTION_HUB_STAGE === "TEST",
    );
    const response = NextResponse.redirect(
      new URL(token ? "/distribution" : "/distribution/login?error=1", origin),
      303,
    );
    response.headers.set("Cache-Control", "no-store");
    if (token)
      response.cookies.set(STUDIO_SESSION_COOKIE, token, {
        httpOnly: true,
        secure: origin.startsWith("https:"),
        sameSite: "lax",
        path: "/distribution",
        maxAge: 43200,
      });
    return response;
  } catch {
    return new Response("Sign-in is temporarily unavailable.", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
