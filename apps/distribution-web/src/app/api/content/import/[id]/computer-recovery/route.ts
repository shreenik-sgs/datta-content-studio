import { computerRecoveryActionSchema } from "@satsang/distribution-contracts";
import { COMPUTER_RECOVERY_ERRORS, computerRecoveryEnabled } from "@satsang/distribution-domain";
import { z } from "zod";
import { boundedJson, json, safeProblem } from "../../../../../../lib/http";
import { computerRecoveryRequest } from "../../../../../../lib/import-verification";
import { access } from "../../../../../../lib/runtime";

export async function POST(request: Request, route: { params: Promise<{ id: string }> }) {
  const auth = await access(request, "content.create");
  if (!auth.ok) return auth.response;
  if (!computerRecoveryEnabled(process.env)) return json({ error: "RECOVERY_LOCAL_REQUIRED" }, 403);
  try {
    const id = z
      .string()
      .uuid()
      .parse((await route.params).id);
    const command = computerRecoveryActionSchema.parse(await boundedJson(request));
    return json(await computerRecoveryRequest(auth.context, id, command));
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (Object.hasOwn(COMPUTER_RECOVERY_ERRORS, code)) return json({ error: code }, 409);
    if (code.startsWith("VERIFICATION_")) return json({ error: "RECOVERY_NOT_CONFIGURED" }, 503);
    return safeProblem(error);
  }
}
