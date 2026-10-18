import { renderRequestSchema } from "@satsang/distribution-contracts";
import { z } from "zod";
import { boundedJson, json, safeProblem } from "../../../lib/http";
import { requireNativeRenderPolicy } from "../../../lib/native-render-policy";
import {
  publicRenderArtifact,
  publicRenderJob,
  renderArtifactNaming,
  renderRepository,
} from "../../../lib/render-runtime";
import { access } from "../../../lib/runtime";
export async function GET(request: Request) {
  const auth = await access(request);
  if (!auth.ok) return auth.response;
  try {
    const masterId = z.string().uuid().parse(new URL(request.url).searchParams.get("masterId"));
    const repo = renderRepository();
    const [jobs, artifacts] = await Promise.all([
      repo.listJobs(auth.context, masterId),
      repo.listArtifacts(auth.context, masterId),
    ]);
    return json({
      jobs: jobs.map(publicRenderJob),
      artifacts: artifacts.map(({ artifact, eligibility }) => {
        const job = jobs.find((value) => value.id === artifact.jobId);
        return {
          artifact: publicRenderArtifact(
            artifact,
            job ? renderArtifactNaming(artifact, job) : undefined,
          ),
          eligibility,
        };
      }),
    });
  } catch (error) {
    return safeProblem(error);
  }
}
export async function POST(request: Request) {
  const auth = await access(request, "content.create");
  if (!auth.ok) return auth.response;
  try {
    const command = renderRequestSchema.parse(await boundedJson(request));
    await requireNativeRenderPolicy(request, auth.context, { masterId: command.masterId });
    const job = await renderRepository().enqueue(auth.context, command);
    return json({ job: publicRenderJob(job) }, 201);
  } catch (error) {
    return safeProblem(error);
  }
}
