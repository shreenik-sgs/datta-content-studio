import { studioReviewAssignment } from "@satsang/distribution-db";
import { studioPackageBlockers } from "@satsang/distribution-domain";
import { z } from "zod";
import { json } from "../../../../lib/http";
import { access, distributionPool } from "../../../../lib/runtime";
import {
  publicStudioPackage,
  publicStudioPublication,
  studioProblem,
  studioReadiness,
  studioRepository,
} from "../../../../lib/studio-runtime";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await access(request);
  if (!auth.ok) return auth.response;
  try {
    const id = z
      .string()
      .uuid()
      .parse((await params).id);
    const repo = studioRepository();
    const value = await repo.get(auth.context, id);
    const [master, publications, readiness] = await Promise.all([
      auth.repo.get(auth.context, value.source.masterId),
      repo.listPublications(auth.context, id),
      studioReadiness(auth.context),
    ]);
    return json({
      package: publicStudioPackage(value),
      publications: publications.map(publicStudioPublication),
      readiness,
      reviewAssignment: auth.capabilities.includes("content.review")
        ? await studioReviewAssignment(
            distributionPool(),
            auth.context.userId,
            auth.context.isTest,
            value.source.language,
          )
        : undefined,
      blockers: studioPackageBlockers(value, master, new Date().toISOString()),
    });
  } catch (error) {
    return studioProblem(error);
  }
}
