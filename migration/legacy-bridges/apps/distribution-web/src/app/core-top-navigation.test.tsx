// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { CoreNavigation } from "../lib/core-navigation";
import { CoreTopNavigation } from "./core-top-navigation";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

it("reserves the measured navigation height and keeps seven narrow-screen links without losing a destination", async () => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 10,
    y: 653,
    top: 653,
    right: 310,
    bottom: 800,
    left: 10,
    width: 300,
    height: 147,
    toJSON: () => ({}),
  });
  const icon = {
    viewBox: "0 0 1000 1000",
    transform: "translate(0 1000) scale(1 -1)",
    on: "M0 0Z",
    off: "M0 0Z",
  } as const;
  const navigation: CoreNavigation = {
    version: 1,
    locale: "en",
    label: "Sannidhi",
    tabs: [
      { key: "practices", href: "/home", label: "Practices", icon },
      { key: "community", href: "/community", label: "Community", icon },
      { key: "reporting", href: "/reporting", label: "Reporting", icon },
      { key: "sayings", href: "/sayings", label: "Sayings", icon },
      { key: "content", href: "/distribution", label: "Content", icon },
      { key: "admin", href: "/admin", label: "Admin", icon },
      { key: "you", href: "/profile", label: "Profile", icon },
    ],
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(<CoreTopNavigation navigation={navigation} coreOrigin="http://localhost:3020" />),
  );
  const bar = container.querySelector("nav");
  expect(document.body.style.getPropertyValue("--core-navigation-height")).toBe("147px");
  expect(bar?.querySelectorAll("a")).toHaveLength(7);
  expect(bar?.querySelector('[aria-current="page"]')?.textContent).toBe("Content");
  await act(async () => root.unmount());
  expect(document.body.style.getPropertyValue("--core-navigation-height")).toBe("");
});
