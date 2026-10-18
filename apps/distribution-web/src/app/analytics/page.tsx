import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { analyticsEnabled } from "../../lib/analytics-policy";
import { trustedDistributionOrigin } from "../../lib/auth";
import { access } from "../../lib/runtime";
import { AnalyticsDashboard } from "./analytics-dashboard";
export const dynamic = "force-dynamic";
export default async function AnalyticsPage() {
  const request = new Request(
    `${trustedDistributionOrigin(process.env.DISTRIBUTION_APP_ORIGIN) ?? "http://localhost"}/distribution/analytics`,
    { headers: await headers() },
  );
  const auth = await access(request, "analytics.view");
  if (!auth.ok || !(await analyticsEnabled(request))) notFound();
  return (
    <AnalyticsDashboard
      canManage={auth.capabilities.includes("operations.manage")}
      isTest={auth.context.isTest}
    />
  );
}
