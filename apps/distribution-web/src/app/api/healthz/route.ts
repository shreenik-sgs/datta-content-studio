import { distributionHealthSchema } from "@satsang/distribution-contracts";
import { NextResponse } from "next/server";
import { distributionStage } from "../../../config";

export const dynamic = "force-dynamic";

export function GET() {
  const body = distributionHealthSchema.parse({
    service: "distribution-web",
    version: 1,
    stage: distributionStage(process.env.DISTRIBUTION_HUB_STAGE),
    status: "ok",
  });
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
