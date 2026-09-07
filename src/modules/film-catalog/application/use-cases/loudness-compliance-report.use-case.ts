/**
 * loudness-compliance-report.use-case.ts
 *
 * Generates a delivery-ready loudness compliance report for films and trailers
 * conforming to common broadcast and cinema standards (EBU R128, ATSC A/85,
 * Apple iTunes / Spotify-style podcast specs, theatrical DCP).
 *
 * Pipeline:
 *   - Aggregates sample-accurate integrated loudness (LUFS), true peak (dBTP),
 *     loudness range (LU) and short-term maxima from the analyzer output of
 *     `analyze-audio-loudness.use-case`.
 *   - Evaluates each enabled target spec against the measurements and emits
 *     pass/fail reasons.
 *   - Calculates suggested gain correction per channel layout.
 *
 * All math runs on plain TypeScript so this module can be reused inside the
 * autonomous engine (Node runtime) and inside the rendering server without
 * pulling native FFmpeg bindings.
 */

export type LoudnessTarget = 'ebu-r128' | 'atsc-a85' | 'apple-podcast' | 'theatrical-dcp';

export interface LoudnessMeasurement {
  channelLayout: 'mono' | 'stereo' | '5.1' | '7.1.4';
  /** Integrated loudness, LUFS. */
  integratedLufs: number;
  /** Loudness Range (LU) per EBU R128. */
  loudnessRangeLu: number;
  /** Maximum short-term loudness window (LUFS). */
  maxShortTermLufs: number;
  /** Maximum true-peak, dBTP. */
  maxTruePeakDbtp: number;
  /** Maximum momentary loudness window (LUFS). */
  maxMomentaryLufs: number;
  /** Program duration in seconds. */
  durationSeconds: number;
}

export interface LoudnessSpec {
  target: LoudnessTarget;
  /** Target integrated loudness in LUFS. */
  targetIntegratedLufs: number;
  /** Absolute tolerance (+/- LU) considered compliant. */
  toleranceLu: number;
  /** Hard ceiling for true peak, dBTP. */
  maxTruePeakDbtp: number;
  /** Maximum permitted loudness range (LU). Infinity if not enforced. */
  maxLoudnessRangeLu: number;
  /** Human readable spec name. */
  label: string;
}

export interface LoudnessComplianceResult {
  target: LoudnessTarget;
  label: string;
  passed: boolean;
  /** Suggested linear gain (multiplier) to apply to reach target. */
  correctionGainDb: number;
  correctionGainLinear: number;
  reasons: string[];
}

export interface LoudnessComplianceReport {
  filmId: string;
  channelLayout: LoudnessMeasurement['channelLayout'];
  generatedAtIso: string;
  measurement: LoudnessMeasurement;
  results: LoudnessComplianceResult[];
  overallPassed: boolean;
}

const BUILT_IN_SPECS: Record<LoudnessTarget, LoudnessSpec> = {
  'ebu-r128': {
    target: 'ebu-r128',
    label: 'EBU R128 (European Broadcasting)',
    targetIntegratedLufs: -23,
    toleranceLu: 0.5,
    maxTruePeakDbtp: -1,
    maxLoudnessRangeLu: 20,
  },
  'atsc-a85': {
    target: 'atsc-a85',
    label: 'ATSC A/85 (US Broadcast, CALM Act)',
    targetIntegratedLufs: -24,
    toleranceLu: 2,
    maxTruePeakDbtp: -2,
    maxLoudnessRangeLu: Infinity,
  },
  'apple-podcast': {
    target: 'apple-podcast',
    label: 'Apple Podcasts / iTunes (Voice)',
    targetIntegratedLufs: -16,
    toleranceLu: 1,
    maxTruePeakDbtp: -1,
    maxLoudnessRangeLu: 12,
  },
  'theatrical-dcp': {
    target: 'theatrical-dcp',
    label: 'Theatrical DCP (SMPTE 428 / 429)',
    targetIntegratedLufs: -20,
    toleranceLu: 1,
    maxTruePeakDbtp: -2,
    maxLoudnessRangeLu: Infinity,
  },
};

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

function linearToDb(linear: number): number {
  if (linear <= 0) return -Infinity;
  return 20 * Math.log10(linear);
}

function evaluateAgainstSpec(
  measurement: LoudnessMeasurement,
  spec: LoudnessSpec,
): LoudnessComplianceResult {
  const reasons: string[] = [];

  const deltaLu = measurement.integratedLufs - spec.targetIntegratedLufs;
  const correctionDb = -deltaLu;
  const correctionLinear = dbToLinear(correctionDb);

  if (Math.abs(deltaLu) > spec.toleranceLu) {
    reasons.push(
      `Integrated loudness ${measurement.integratedLufs.toFixed(2)} LUFS is outside +/-${spec.toleranceLu} LU of target ${spec.targetIntegratedLufs} LUFS (delta ${deltaLu.toFixed(2)} LU).`,
    );
  }

  if (measurement.maxTruePeakDbtp > spec.maxTruePeakDbtp) {
    reasons.push(
      `True peak ${measurement.maxTruePeakDbtp.toFixed(2)} dBTP exceeds ceiling ${spec.maxTruePeakDbtp} dBTP.`,
    );
  }

  if (
    Number.isFinite(spec.maxLoudnessRangeLu) &&
    measurement.loudnessRangeLu > spec.maxLoudnessRangeLu
  ) {
    reasons.push(
      `Loudness range ${measurement.loudnessRangeLu.toFixed(2)} LU exceeds limit ${spec.maxLoudnessRangeLu} LU.`,
    );
  }

  if (reasons.length === 0) {
    reasons.push('All compliance checks passed.');
  }

  return {
    target: spec.target,
    label: spec.label,
    passed: reasons.length === 1 && reasons[0].startsWith('All compliance'),
    correctionGainDb: Number(correctionDb.toFixed(2)),
    correctionGainLinear: Number(correctionLinear.toFixed(4)),
    reasons,
  };
}

export interface BuildLoudnessComplianceReportInput {
  filmId: string;
  measurement: LoudnessMeasurement;
  targets?: LoudnessTarget[];
}

export function buildLoudnessComplianceReport(
  input: BuildLoudnessComplianceReportInput,
): LoudnessComplianceReport {
  const targets = input.targets ?? (Object.keys(BUILT_IN_SPECS) as LoudnessTarget[]);
  const results = targets.map((target) =>
    evaluateAgainstSpec(input.measurement, BUILT_IN_SPECS[target]),
  );

  return {
    filmId: input.filmId,
    channelLayout: input.measurement.channelLayout,
    generatedAtIso: new Date().toISOString(),
    measurement: input.measurement,
    results,
    overallPassed: results.every((r) => r.passed),
  };
}

export const LOUDNESS_SPECS = BUILT_IN_SPECS;
export { linearToDb, dbToLinear };
