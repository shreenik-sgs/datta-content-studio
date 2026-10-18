import { studioCreateSchema, studioListSchema } from "@satsang/distribution-contracts";
import { json } from "../../../lib/http";
import { access } from "../../../lib/runtime";
import {
  publicStudioPackage,
  studioJson,
  studioProblem,
  studioReadiness,
  studioRepository,
} from "../../../lib/studio-runtime";

export async function GET(request: Request) {
  const auth = await access(request);
  if (!auth.ok) return auth.response;
  try {
    const query = studioListSchema.parse(Object.fromEntries(new URL(request.url).searchParams));
    const packages = await studioRepository().list(auth.context, query);
    return json({
      packages: packages
        .filter((item) => !query.status || item.status === query.status)
        .map(publicStudioPackage),
      readiness: await studioReadiness(auth.context),
    });
  } catch (error) {
    return studioProblem(error);
  }
}

export async function POST(request: Request) {
  const auth = await access(request, "content.create");
  if (!auth.ok) return auth.response;
  try {
    const command = studioCreateSchema.parse(await studioJson(request));
    const value = await studioRepository().create(auth.context, command);
    return json({ package: publicStudioPackage(value) }, 201);
  } catch (error) {
    return studioProblem(error);
  }
}
