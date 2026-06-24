import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Legend } from "./Legend.js";
import { STOP_STATUS_LABELS } from "./stopColoring.js";

/**
 * SP2 Task 6 (spec §8) — the Legend gains a "Truck status" section (moving /
 * rested / refueling) so an operator can read the parked/refueling markers. The
 * section's labels come from the SAME `STOP_STATUS_LABELS` single source of truth
 * the stop StyleFunction uses, so the legend can never diverge from the map.
 */
describe("Legend — Truck status section (SP2 §8)", () => {
  it("renders the 'Truck status' heading", () => {
    render(<Legend />);
    expect(screen.getByText("Truck status")).toBeInTheDocument();
  });

  it("renders one row per truck-status label (single source of truth)", () => {
    render(<Legend />);
    for (const label of STOP_STATUS_LABELS) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});
