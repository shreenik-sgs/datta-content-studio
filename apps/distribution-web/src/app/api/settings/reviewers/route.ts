import { listStudioReviewers, saveStudioReviewerLanguages } from "@satsang/distribution-db";
import { REVIEWER_LANGUAGES } from "@satsang/distribution-domain";
import { z } from "zod";
import { studioSessionToken } from "../../../../lib/auth";
import { json, readBoundedBody, safeProblem } from "../../../../lib/http";
import { access, distributionPool } from "../../../../lib/runtime";
const languages = z.array(z.string().refine((v) => Object.hasOwn(REVIEWER_LANGUAGES, v))).max(8);
const schema = z
  .object({
    operatorId: z.string().uuid(),
    expectedLanguages: languages,
    languages,
    confirmProficiency: z.literal(true),
  })
  .strict();
export async function GET(request: Request) {
  const auth = await access(request, "operations.manage");
  if (!auth.ok) return auth.response;
  if (!auth.context.roles.includes("SUPER_ADMIN")) return json({ error: "FORBIDDEN" }, 403);
  try {
    return json({ reviewers: await listStudioReviewers(distributionPool(), auth.context.isTest) });
  } catch (error) {
    return safeProblem(error);
  }
}
export async function POST(request: Request) {
  const auth = await access(request, "operations.manage");
  if (!auth.ok) return auth.response;
  if (!auth.context.roles.includes("SUPER_ADMIN")) return json({ error: "FORBIDDEN" }, 403);
  try {
    const command = schema.parse(
      JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 4096))),
    );
    const sessionToken = studioSessionToken(request);
    if (!sessionToken) return json({ error: "sign_in_required" }, 401);
    await saveStudioReviewerLanguages(distributionPool(), {
      ...command,
      isTest: auth.context.isTest,
      sessionToken,
    });
    return json({ reviewers: await listStudioReviewers(distributionPool(), auth.context.isTest) });
  } catch (error) {
    return safeProblem(error);
  }
}
