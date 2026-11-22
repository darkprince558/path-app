/** Metric agent settings cannot be applied to relative/unknown coordinates. */
export function automaticNavigationIssue(metadata: Record<string, unknown> | undefined): string | undefined {
  const frame = metadata?.coordinateSystem as { units?: unknown; upAxis?: unknown; calibrated?: unknown } | undefined;
  if (metadata?.alignmentVerified !== true || frame?.units !== "metres" || frame.upAxis !== "Y" || frame.calibrated !== true) {
    return "Automatic routing requires owner-verified alignment in calibrated metres with +Y up.";
  }
  return undefined;
}
