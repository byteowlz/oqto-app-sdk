import { describe, expect, it } from "vitest";
import { applyOqtoTheme } from "../src/index.js";

describe("applyOqtoTheme", () => {
  it("applies only CSS custom properties to one root", () => {
    const properties = new Map<string, string>();
    const element = {
      dataset: {},
      style: {
        setProperty(name: string, value: string) {
          properties.set(name, value);
        },
      },
    } as unknown as HTMLElement;

    applyOqtoTheme(element, {
      colorScheme: "dark",
      tokens: { "--oqto-bg": "#000", color: "red" },
    });

    expect(element.dataset.oqtoColorScheme).toBe("dark");
    expect(properties).toEqual(new Map([["--oqto-bg", "#000"]]));
  });
});
