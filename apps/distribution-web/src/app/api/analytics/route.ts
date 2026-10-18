import { analyticsCommandSchema } from "@satsang/distribution-contracts";
import { analyticsEnabled } from "../../../lib/analytics-policy";
import { analyticsRepository } from "../../../lib/analytics-runtime";
import { json, readBoundedBody, safeProblem } from "../../../lib/http";
import { access } from "../../../lib/runtime";
export async function GET(request: Request) {
  const auth = await access(request, "analytics.view");
  if (!auth.ok) return auth.response;
  if (!(await analyticsEnabled(request))) return json({ error: "FEATURE_UNAVAILABLE" }, 404);
  try {
    return json({ version: 1, ...(await analyticsRepository().dashboard(auth.context)) });
  } catch (error) {
    return safeProblem(error);
  }
}
export async function POST(request: Request) {
  const auth = await access(request, "operations.manage");
  if (!auth.ok) return auth.response;
  if (!(await analyticsEnabled(request))) return json({ error: "FEATURE_UNAVAILABLE" }, 404);
  try {
    let input: unknown;
    const body = await readBoundedBody(request, 1024 * 1024);
    try {
      input = JSON.parse(new TextDecoder().decode(body));
    } catch {
      throw new Error("INVALID_REQUEST");
    }
    const command = analyticsCommandSchema.parse(input);
    const repo = analyticsRepository();
    switch (command.action) {
      case "approve_policy":
        await repo.approvePolicy(auth.context, command);
        return json({ ok: true });
      case "ingest":
        return json(await repo.ingest(auth.context, command.events));
      case "reconcile_recent":
      case "reconcile":
        await repo.reconcile(auth.context, command);
        return json({ ok: true });
      case "provider_snapshot":
        await repo.providerSnapshot(auth.context, command);
        return json({ ok: true });
    }
  } catch (error) {
    return safeProblem(error);
  }
}
