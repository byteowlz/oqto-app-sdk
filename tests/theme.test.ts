// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyOqtoTheme } from "../src/index.js";

function root(): HTMLElement {
  return document.implementation.createHTMLDocument().createElement("div");
}

describe("applyOqtoTheme", () => {
  it("applies only CSS custom properties to one root", () => {
    const element = root();
    applyOqtoTheme(element, { colorScheme: "dark", tokens: { "--oqto-bg": "#000", color: "red" } });

    expect(element.dataset.oqtoColorScheme).toBe("dark");
    expect(element.style.getPropertyValue("--oqto-bg")).toBe("#000");
    expect(element.style.getPropertyValue("color")).toBe("");
  });

  it("treats each call as a full snapshot and withdraws omitted tokens", () => {
    const element = root();
    element.style.setProperty("--app-local", "8px");
    applyOqtoTheme(element, {
      colorScheme: "dark",
      tokens: { "--oqto-bg": "black", "--oqto-accent": "red" },
    });
    applyOqtoTheme(element, { colorScheme: "light", tokens: { "--oqto-bg": "white" } });

    expect(element.dataset.oqtoColorScheme).toBe("light");
    expect(element.style.getPropertyValue("--oqto-bg")).toBe("white");
    expect(element.style.getPropertyValue("--oqto-accent")).toBe("");
    expect(element.style.getPropertyValue("--app-local")).toBe("8px");
  });

  it("withdraws every helper-owned token on an empty snapshot", () => {
    const element = root();
    element.style.setProperty("--app-local", "8px");
    applyOqtoTheme(element, { colorScheme: "dark", tokens: { "--oqto-bg": "black" } });
    applyOqtoTheme(element, { colorScheme: "dark", tokens: {} });

    expect(element.style.getPropertyValue("--oqto-bg")).toBe("");
    expect(element.style.getPropertyValue("--app-local")).toBe("8px");
  });

  it("restores a pre-existing value (and priority) it overwrote when withdrawn", () => {
    const element = root();
    element.style.setProperty("--oqto-accent", "blue", "important");
    applyOqtoTheme(element, { colorScheme: "dark", tokens: { "--oqto-accent": "red" } });
    expect(element.style.getPropertyValue("--oqto-accent")).toBe("red");

    // Repeated applies must keep the original prior value, not the helper's own.
    applyOqtoTheme(element, { colorScheme: "dark", tokens: { "--oqto-accent": "green" } });
    applyOqtoTheme(element, { colorScheme: "light", tokens: {} });

    expect(element.style.getPropertyValue("--oqto-accent")).toBe("blue");
    expect(element.style.getPropertyPriority("--oqto-accent")).toBe("important");
  });

  it("tracks ownership independently per root", () => {
    const first = root();
    const second = root();
    applyOqtoTheme(first, { colorScheme: "dark", tokens: { "--oqto-accent": "red" } });
    applyOqtoTheme(second, { colorScheme: "dark", tokens: { "--oqto-accent": "red" } });
    applyOqtoTheme(first, { colorScheme: "light", tokens: {} });

    expect(first.style.getPropertyValue("--oqto-accent")).toBe("");
    expect(second.style.getPropertyValue("--oqto-accent")).toBe("red");
  });
});
