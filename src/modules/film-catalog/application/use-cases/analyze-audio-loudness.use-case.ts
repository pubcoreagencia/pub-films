import { AudioLoudnessAnalyzer, LoudnessMeasurement, LoudnessStandard, LUFS_THRESHOLDS } from '../../audio/loudness-analyzer';
import { FilmRepository } from '../../domain/repositories/film.repository';
import { MasteringPresetRepository } from '../../domain/repositories/mastering-preset.repository';
import { AudioAssetStorage } from '../../infrastructure/storage/audio-asset.storage';

export interface AnalyzeAudioLoudnessInput {
  filmId: string;
  audioAssetKey: string;
  standard?: LoudnessStandard;
  truePeakCeiling?: number;
  loudnessTarget?: number;
  previousPresetId?: string;
}

export interface AnalyzeAudioLoudnessOutput {
  filmId: string;
  measurement: LoudnessMeasurement;
  compliance: {
    passesBroadcast: boolean;
    passesStreaming: boolean;
    passesCinema: boolean;
    violations: string[];
    deltaLU: number;
  };
  recommendations: {
    appliedGainDb: number;
    appliedPresetId?: string;
    notes: string[];
  };
  matchedPreset?: {
    presetId: string;
    name: string;
    score: number;
  };
  analyzedAt: string;
}

export class AnalyzeAudioLoudnessUseCase {
  constructor(
    private readonly filmRepository: FilmRepository,
    private readonly presetRepository: MasteringPresetRepository,
    private readonly audioStorage: AudioAssetStorage,
    private readonly analyzer: AudioLoudnessAnalyzer
  ) {}

  async execute(input: AnalyzeAudioLoudnessInput): Promise<AnalyzeAudioLoudnessOutput> {
    const film = await this.filmRepository.findById(input.filmId);
    if (!film) {
      throw new Error(`Film ${input.filmId} not found in catalog`);
    }

    const audioBuffer = await this.audioStorage.downloadAsDecodedBuffer(input.audioAssetKey);
    const standard = input.standard ?? this.detectStandardFromGenre(film.genre);
    const target = input.loudnessTarget ?? LUFS_THRESHOLDS[standard];

    const measurement = await this.analyzer.measure(audioBuffer, {
      standard,
      targetLUFS: target,
      truePeakCeiling: input.truePeakCeiling ?? -1.0,
      windowSeconds: 3
    });

    const compliance = this.evaluateCompliance(measurement, standard);
    const appliedGainDb = this.calculateGainCorrection(measurement.integratedLUFS, target);

    const presets = await this.presetRepository.listByFilmGenre(film.genre, standard);
    const matchedPreset = this.matchBestPreset(presets, measurement, target);

    const recommendations = this.buildRecommendations({
      measurement,
      compliance,
      appliedGainDb,
      matchedPreset,
      previousPresetId: input.previousPresetId
    });

    if (matchedPreset && matchedPreset.score >= 0.85) {
      await this.presetRepository.recordUsage(matchedPreset.presetId, film.id);
    }

    await this.filmRepository.appendAudioProfile(film.id, {
      integratedLUFS: measurement.integratedLUFS,
      truePeakDb: measurement.truePeakDb,
      lra: measurement.loudnessRange,
      standard,
      measuredAt: new Date().toISOString()
    });

    return {
      filmId: film.id,
      measurement,
      compliance,
      recommendations,
      matchedPreset,
      analyzedAt: new Date().toISOString()
    };
  }

  private detectStandardFromGenre(genre: string): LoudnessStandard {
    const normalized = genre.toLowerCase();
    if (normalized.includes('documentary') || normalized.includes('news')) return 'EBU_R128';
    if (normalized.includes('cinema') || normalized.includes('imax')) return 'ATSC_A85_CINEMA';
    if (normalized.includes('ad') || normalized.includes('commercial')) return 'AMWA_ADOBE';
    if (normalized.includes('music') || normalized.includes('concert')) return 'STREAMING_MUSIC';
    return 'STREAMING';
  }

  private evaluateCompliance(
    measurement: LoudnessMeasurement,
    standard: LoudnessStandard
  ): AnalyzeAudioLoudnessOutput['compliance'] {
    const target = LUFS_THRESHOLDS[standard];
    const tolerance = standard === 'EBU_R128' ? 0.5 : 1.0;
    const deltaLU = measurement.integratedLUFS - target;
    const violations: string[] = [];

    if (Math.abs(deltaLU) > tolerance) {
      violations.push(
        `Integrated loudness ${measurement.integratedLUFS.toFixed(1)} LUFS deviates ${Math.abs(deltaLU).toFixed(1)} LU from ${standard} target ${target} LUFS`
      );
    }

    const truePeakLimit = standard === 'ATSC_A85_CINEMA' ? -2.0 : -1.0;
    if (measurement.truePeakDb > truePeakLimit) {
      violations.push(
        `True peak ${measurement.truePeakDb.toFixed(2)} dBTP exceeds ceiling ${truePeakLimit} dBTP`
      );
    }

    if (measurement.loudnessRange > 20 && standard !== 'STREAMING_MUSIC') {
      violations.push(`Excessive dynamic range (LRA ${measurement.loudnessRange.toFixed(1)} LU) for ${standard}`);
    }

    return {
      passesBroadcast: standard === 'EBU_R128' && violations.length === 0,
      passesStreaming: ['STREAMING', 'STREAMING_MUSIC', 'AMWA_ADOBE'].includes(standard) && violations.length === 0,
      passesCinema: standard === 'ATSC_A85_CINEMA' && violations.length === 0,
      violations,
      deltaLU
    };
  }

  private calculateGainCorrection(integratedLUFS: number, targetLUFS: number): number {
    const correction = targetLUFS - integratedLUFS;
    return Math.max(-12, Math.min(12, correction));
  }

  private matchBestPreset(
    presets: Awaited<ReturnType<MasteringPresetRepository['listByFilmGenre']>>,
    measurement: LoudnessMeasurement,
    targetLUFS: number
  ): AnalyzeAudioLoudnessOutput['matchedPreset'] | undefined {
    if (presets.length === 0) return undefined;

    let bestScore = -Infinity;
    let bestPreset = presets[0];

    for (const preset of presets) {
      const loudnessDelta = Math.abs(preset.targetIntegratedLUFS - measurement.integratedLUFS);
      const peakDelta = Math.abs(preset.targetTruePeakDb - measurement.truePeakDb);
      const targetAlignment = 1 - Math.min(1, Math.abs(preset.targetIntegratedLUFS - targetLUFS) / 5);

      const score = targetAlignment * 0.5 + (1 - Math.min(1, loudnessDelta / 10)) * 0.3 + (1 - Math.min(1, peakDelta / 3)) * 0.2;

      if (score > bestScore) {
        bestScore = score;
        bestPreset = preset;
      }
    }

    return {
      presetId: bestPreset.id,
      name: bestPreset.name,
      score: Number(bestScore.toFixed(3))
    };
  }

  private buildRecommendations(params: {
    measurement: LoudnessMeasurement;
    compliance: AnalyzeAudioLoudnessOutput['compliance'];
    appliedGainDb: number;
    matchedPreset?: AnalyzeAudioLoudnessOutput['matchedPreset'];
    previousPresetId?: string;
  }): AnalyzeAudioLoudnessOutput['recommendations'] {
    const notes: string[] = [];
    const { measurement, compliance, appliedGainDb, matchedPreset, previousPresetId } = params;

    if (Math.abs(appliedGainDb) >= 0.1) {
      const direction = appliedGainDb > 0 ? 'boost' : 'attenuate';
      notes.push(
        `Apply ${direction} of ${Math.abs(appliedGainDb).toFixed(2)} dB on master bus to reach target integrated loudness`
      );
    }

    if (measurement.truePeakDb > -1.0) {
      notes.push('Insert true-peak limiter at -1.0 dBTP to prevent inter-sample clipping on streaming encodes');
    }

    if (measurement.loudnessRange < 4) {
      notes.push('LRA too low; consider expanding dynamic elements (dialog breath, ambient tails) for cinematic depth');
    } else if (measurement.loudnessRange > 18) {
      notes.push('High LRA detected; apply gentle bus compression (2:1, slow attack) to stabilize dialogue against peaks');
    }

    if (compliance.violations.length > 0) {
      notes.push(`Resolve ${compliance.violations.length} compliance violation(s) before delivery`);
    }

    if (matchedPreset && matchedPreset.score >= 0.9) {
      notes.push(`High-confidence preset match: "${matchedPreset.name}" (score ${matchedPreset.score})`);
      if (previousPresetId && previousPresetId !== matchedPreset.presetId) {
        notes.push(`Switching away from previous preset ${previousPresetId} based on measured spectrum profile`);
      }
    }

    return {
      appliedGainDb: Number(appliedGainDb.toFixed(2)),
      appliedPresetId: matchedPreset && matchedPreset.score >= 0.75 ? matchedPreset.presetId : undefined,
      notes
    };
  }
}
