/**
 * Legend.tsx jsdom reference test (the `ui` lane).
 *
 * Proves the jsdom React Testing Library lane works end-to-end:
 *  - render a real component with `@testing-library/react`
 *  - assert visible DOM (jest-dom matchers from the jsdom setup)
 *
 * Legend is a pure, data-free overlay (VIZ-03), so it needs no MSW — it is the
 * smallest honest proof that `*.test.tsx` renders and is credited to coverage.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Legend } from "./Legend.js";
import { HUB_BUCKET_LABELS, ROUTE_BUCKET_LABELS } from "./coloring.js";

describe("Legend (jsdom ui lane)", () => {
  it("mounts the legend overlay with the accessible landmark", () => {
    render(<Legend />);
    const legend = screen.getByTestId("map-legend");
    expect(legend).toBeInTheDocument();
    expect(legend).toHaveAttribute("aria-label", "Map legend");
  });

  it("renders the default hub + route metric headings", () => {
    render(<Legend />);
    // Default props: hubMetric="volume", routeMetric="load".
    expect(screen.getByText("Hub volume")).toBeInTheDocument();
    expect(screen.getByText("Route load")).toBeInTheDocument();
  });

  it("renders one labelled row per hub + route bucket (single source of truth)", () => {
    render(<Legend />);
    // Every bucket label from coloring.ts must appear in the rendered legend.
    for (const label of HUB_BUCKET_LABELS) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    for (const label of ROUTE_BUCKET_LABELS) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("reflects a non-default metric in the heading", () => {
    render(<Legend hubMetric="slaRisk" routeMetric="slaRisk" />);
    expect(screen.getByText("Hub SLA risk")).toBeInTheDocument();
    expect(screen.getByText("Route SLA risk")).toBeInTheDocument();
  });
});
