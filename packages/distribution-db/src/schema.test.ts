import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { distributionModuleState } from "./index";

describe("DS-DIST-R0 persistence boundary", () => {
  it("DS-DIST-R0-08 owns an additive table in the distribution schema", () => {
    expect(getTableName(distributionModuleState)).toBe("module_state");
    expect(getTableConfig(distributionModuleState).schema).toBe("distribution");
  });
});
