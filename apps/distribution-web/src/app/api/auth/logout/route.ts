import { operatorTokenHash, studioIdentityPool } from "@satsang/distribution-db";
import { NextResponse } from "next/server";
import {
  STUDIO_SESSION_COOKIE,
  studioSessionToken,
  validStudioMutationOrigin,
} from "../../../../lib/auth";
export async function POST(request: Request) {
  if (!validStudioMutationOrigin(request)) return new Response("Invalid origin", { status: 403 });
  const token = studioSessionToken(request);
  if (token)
    await studioIdentityPool().query(
      "DELETE FROM distribution.operator_session WHERE token_hash=$1",
      [operatorTokenHash(token)],
    );
  const response = NextResponse.redirect(
    new URL("/distribution/login", process.env.DISTRIBUTION_APP_ORIGIN),
    303,
  );
  response.cookies.set(STUDIO_SESSION_COOKIE, "", {
    httpOnly: true,
    secure: process.env.DISTRIBUTION_APP_ORIGIN?.startsWith("https:") ?? false,
    sameSite: "lax",
    path: "/distribution",
    maxAge: 0,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
