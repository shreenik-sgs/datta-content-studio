import { json, safeProblem } from "../../../../lib/http";
import { access } from "../../../../lib/runtime";
import { masterUploadLimit } from "../../../../lib/upload-policy";
export async function GET(request: Request) {
  const auth = await access(request, "content.create");
  if (!auth.ok) return auth.response;
  try {
    return json({ maxMasterBytes: await masterUploadLimit(auth.context.isTest) });
  } catch (error) {
    return safeProblem(error);
  }
}
