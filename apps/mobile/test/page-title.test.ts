import { describe, expect, it } from "vitest";
import { pageTitle } from "../src/web/page-title";

describe("pageTitle", () => {
  it("uses the page's own title, tidied", () => {
    expect(pageTitle("  Grafana \n  Home ", "http://127.0.0.1:41000/")).toBe("Grafana Home");
  });

  it("falls back to the address when the page has no real title", () => {
    expect(pageTitle(undefined, "http://127.0.0.1:41000/")).toBeNull();
    expect(pageTitle("   ", "http://127.0.0.1:41000/")).toBeNull();
    expect(pageTitle("http://127.0.0.1:41000/a", "http://127.0.0.1:41000/a")).toBeNull();
    expect(pageTitle("127.0.0.1:41000/a", "http://127.0.0.1:41000/a")).toBeNull();
  });

  it("shortens long titles", () => {
    const title = pageTitle("x".repeat(80), undefined);
    expect(title).toHaveLength(40);
    expect(title?.endsWith("…")).toBe(true);
  });
});
