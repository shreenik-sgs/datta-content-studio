"use client";

import { useEffect, useRef } from "react";
import type { CoreNavigation } from "../lib/core-navigation";

/** Plain anchors leave the Hub basePath and enter the core application. */
export function CoreTopNavigation({
  navigation,
  coreOrigin,
}: { navigation: CoreNavigation | null; coreOrigin: string }) {
  const bar = useRef<HTMLElement>(null);
  useEffect(() => {
    const node = bar.current;
    if (!node) return;
    const measure = () => {
      document.body.style.setProperty(
        "--core-navigation-height",
        `${node.getBoundingClientRect().height}px`,
      );
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      document.body.style.removeProperty("--core-navigation-height");
    };
  }, []);
  return (
    <nav
      ref={bar}
      className="core-top-navigation"
      aria-label={navigation?.label ?? "SGS Datta Sannidhi"}
    >
      <ul>
        {navigation ? (
          navigation.tabs.map((tab) => {
            const active = tab.key === "content";
            return (
              <li key={tab.key}>
                <a href={`${coreOrigin}${tab.href}`} aria-current={active ? "page" : undefined}>
                  <svg
                    width="22"
                    height="22"
                    viewBox={tab.icon.viewBox}
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path d={active ? tab.icon.on : tab.icon.off} transform={tab.icon.transform} />
                  </svg>
                  <span>{tab.label}</span>
                </a>
              </li>
            );
          })
        ) : (
          <>
            <li>
              <a href={`${coreOrigin}/home`}>Home</a>
            </li>
            <li>
              <a href={`${coreOrigin}/profile`}>Profile</a>
            </li>
          </>
        )}
      </ul>
    </nav>
  );
}
