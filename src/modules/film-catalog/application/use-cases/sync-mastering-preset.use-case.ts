import { Injectable, Logger } from '@nestjs/common';
import { FilmRepository } from '../../domain/repositories/film.repository';
import { MasteringPresetRepository } from '../../domain/repositories/mastering-preset.repository';
import { MasteringPreset } from '../../domain/entities/mastering-preset.entity';
import { RoomCalibration } from '../../domain/value-objects/room-calibration.vo';
import { LoudnessStandard } from '../../domain/value-objects/loudness-standard.vo';

/**
 * Synchronizes mastering presets across the film catalog with cinema-grade
 * precision. Aligns target loudness to industry standards (EBU R128 / ATSC A/85
 * / Netflix / Dolby Atmos) and compensates for the playback room's acoustic
 * profile. Used both at ingest time and during re-mastering passes.
 */
export interface SyncMasteringPresetInput {
  filmId: string;
  targetStandard?: 'EBU_R128' | 'ATSC_A85' | 'NETFLIX' | 'DOLBY_ATMOS' | 'STREAMING_GENERIC';
  measuredLUFS?: number;
  truePeakDb?: number;
  roomProfile?: {
    rt60Seconds?: number;
    speakerConfig?: 'STEREO' | '5.1' | '7.1.4' | 'ATMOS_BED';
    roomGainDb?: number;
    calibrationMicProfile?: string;
  };
  applyRoomCorrection?: boolean;
}

export interface SyncMasteringPresetOutput {
  filmId: string;
  previousPreset?: MasteringPreset;
  updatedPreset: MasteringPreset;
  appliedStandard: string;
  appliedCorrections: string[];
  loudnessDeltaLU: number;
  expectedImprovementScore: number;
  warnings: string[];
}

const STANDARD_TARGETS: Record<string, { lufs: number; truePeak: number; lra: number }> = {
  EBU_R128: { lufs: -23, truePeak: -1, lra: 7 },
  ATSC_A85: { lufs: -24, truePeak: -2, lra: 8 },
  NETFLIX: { lufs: -27, truePeak: -2, lra: 9 },
  DOLBY_ATMOS: { lufs: -23, truePeak: -1, lra: 7 },
  STREAMING_GENERIC: { lufs: -16, truePeak: -1, lra: 6 },
};

@Injectable()
export class SyncMasteringPresetUseCase {
  private readonly logger = new Logger(SyncMasteringPresetUseCase.name);

  constructor(
    private readonly filmRepository: FilmRepository,
    private readonly presetRepository: MasteringPresetRepository,
  ) {}

  async execute(input: SyncMasteringPresetInput): Promise<SyncMasteringPresetOutput> {
    const film = await this.filmRepository.findById(input.filmId);
    if (!film) throw new Error(`Film ${input.filmId} not found`);

    const standardKey = input.targetStandard ?? this.inferStandard(film);
    const target = STANDARD_TARGETS[standardKey];
    if (!target) throw new Error(`Unsupported loudness standard: ${standardKey}`);

    const previous = await this.presetRepository.findActiveByFilmId(input.filmId);
    const measured = input.measuredLUFS ?? previous?.measuredLUFS ?? -23;
    const loudnessDeltaLU = Number((target.lufs - measured).toFixed(2));

    const calibration = input.roomProfile
      ? RoomCalibration.create(input.roomProfile)
      : previous?.roomCalibration ?? RoomCalibration.default();

    const appliedCorrections: string[] = [];
    const warnings: string[] = [];

    // 1. Loudness normalization
    appliedCorrections.push(
      `loudness-normalization:${standardKey}@${target.lufs}LUFS (Δ ${loudnessDeltaLU}LU)`,
    );

    // 2. True-peak limiting safety
    if ((input.truePeakDb ?? -1) > target.truePeak) {
      warnings.push(
        `True peak ${input.truePeakDb}dBTP exceeds standard ${target.truePeak}dBTP — limiter engaged`,
      );
      appliedCorrections.push(`true-peak-limit:${target.truePeak}dBTP`);
    }

    // 3. Dynamic range / LRA alignment
    appliedCorrections.push(`dynamic-range-target:LRA-${target.lra}`);

    // 4. Room correction (frequency curve derived from RT60 + room gain)
    if (input.applyRoomCorrection && calibration) {
      const eqCurve = calibration.computeRoomEqCurve();
      appliedCorrections.push(
        `room-eq-applied:${calibration.speakerConfig} (${eqCurve.bandCount} bands, RT60=${calibration.rt60Seconds}s)`,
      );
      if (calibration.rt60Seconds > 0.8) {
        warnings.push('RT60 > 0.8s — acoustic treatment recommended before final mix');
      }
    }

    // 5. Beds and object routing for immersive formats
    if (standardKey === 'DOLBY_ATMOS' || calibration.speakerConfig === 'ATMOS_BED') {
      appliedCorrections.push('atmos-bed-7.1.4:bass-management-aligned');
    }

    // 6. Compute expected improvement (heuristic: lower is better when too loud,
    //    higher when too quiet; penalty for LRA mismatch)
    const expectedImprovementScore = this.scoreImprovement(
      loudnessDeltaLU,
      calibration.rt60Seconds,
    );

    const updatedPreset = MasteringPreset.create({
      filmId: film.id,
      standard: LoudnessStandard.of(standardKey, target),
      measuredLUFS: measured,
      targetLUFS: target.lufs,
      truePeakDb: target.truePeak,
      loudnessRange: target.lra,
      roomCalibration: calibration,
      appliedCorrections,
      expectedImprovementScore,
      syncedAt: new Date(),
    });

    await this.presetRepository.upsert(updatedPreset);
    this.logger.log(
      `Film ${film.id} mastered to ${standardKey} | Δ ${loudnessDeltaLU}LU | score ${expectedImprovementScore}`,
    );

    return {
      filmId: film.id,
      previousPreset: previous,
      updatedPreset,
      appliedStandard: standardKey,
      appliedCorrections,
      loudnessDeltaLU,
      expectedImprovementScore,
      warnings,
    };
  }

  private inferStandard(film: any): keyof typeof STANDARD_TARGETS {
    if (film.deliveryTarget === 'cinema') return 'EBU_R128';
    if (film.deliveryTarget === 'streaming') return 'NETFLIX';
    if (film.deliveryTarget === 'broadcast') return 'ATSC_A85';
    if (film.isImmersive) return 'DOLBY_ATMOS';
    return 'STREAMING_GENERIC';
  }

  private scoreImprovement(deltaLU: number, rt60: number): number {
    const loudnessPenalty = Math.min(Math.abs(deltaLU) / 4, 1); // 0..1
    const roomPenalty = Math.min(rt60 / 1.2, 1);
    const raw = 1 - 0.6 * loudnessPenalty - 0.4 * roomPenalty;
    return Number(Math.max(0, Math.min(1, raw)).toFixed(3));
  }
}
