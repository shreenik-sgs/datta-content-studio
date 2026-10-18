import { importVerificationActionSchema } from "@satsang/distribution-contracts";
import { IMPORT_RECOVERY_ERRORS } from "@satsang/distribution-domain";
import { z } from "zod";
import { boundedJson, json, safeProblem } from "../../../../../../lib/http";
import { importVerificationRequest } from "../../../../../../lib/import-verification";
import { access } from "../../../../../../lib/runtime";
export async function POST(request: Request, route: { params: Promise<{ id: string }> }) {
  const auth = await access(request, "content.create");
  if (!auth.ok) return auth.response;
  try {
    const id = z
      .string()
      .uuid()
      .parse((await route.params).id);
    const command = importVerificationActionSchema.parse(await boundedJson(request));
    return json(await importVerificationRequest(auth.context, id, command));
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (IMPORT_RECOVERY_ERRORS[code]) return json({ error: code }, 409);
    return safeProblem(error);
  }
}
