/** Metric agent settings cannot be applied to relative/unknown coordinates. */
export function automaticNavigationIssue(metadata: Record<string, unknown> | undefined): string | undefined {
  const frame = metadata?.coordinateSystem as { units?: unknown; upAxis?: unknown; calibrated?: unknown } | undefined;
  if (metadata?.alignmentVerified !== true || frame?.units !== "metres" || frame.upAxis !== "Y" || frame.calibrated !== true) {
    return "Automatic routing requires owner-verified alignment in calibrated metres with +Y up.";
  }
  return undefined;
}

/** A single GLB has its own frame: use glTF's metre/+Y convention for a preview.
 * Explicit relative or non-Y declarations still require owner calibration.
 * This never changes or asserts persisted calibration for a multi-scan space.
 */
export function singleScanNavigation(metadata: Record<string, unknown> | undefined) {
  const frame = metadata?.coordinateSystem as { units?: unknown; upAxis?: unknown } | undefined;
  const unavailable = (frame?.units !== undefined && frame.units !== "metres") ||
    (frame?.upAxis !== undefined && frame.upAxis !== "Y")
    ? "This model uses relative scale or a different up axis. Verify its scale and +Y floor orientation in Owner tools before routing."
    : undefined;
  return { unavailable, approximate: !!automaticNavigationIssue(metadata) };
}
