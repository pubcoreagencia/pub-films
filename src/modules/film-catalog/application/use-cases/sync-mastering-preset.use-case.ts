import { Injectable, Inject, Logger } from '@nestjs/common';
import { FilmNotFoundError } from '../errors/film-not-found.error';
import { FilmRepositoryPort, FILM_REPOSITORY_TOKEN } from '../ports/film-repository.port';
import { MasteringPreset, MasteringProfile, LoudnessTarget } from '../../domain/entities/mastering-preset.entity';

/**
 * LUFS / True-Peak targets per delivery standard.
 * Values aligned with EBU R128, ATSC A/85 and streaming platform specs
 * (Spotify -14 LUFS, YouTube -14 LUFS, Apple Music -16 LUFS, Cinema B-Chain -23 LUFS).
 */
export type DeliveryStandard =
  | 'EBU_R128'
  | 'ATSC_A85'
  | 'SPOTIFY'
  | 'YOUTUBE'
  | 'APPLE_MUSIC'
  | 'CINEMA_BCHAIN'
  | 'STREAMING_GENERIC';

export interface SyncMasteringPresetInput {
  filmId: string;
  standard: DeliveryStandard;
  profile: MasteringProfile;
  customLoudnessTarget?: number; // override LUFS target (e.g. -23 for theatrical)
  customTruePeakDb?: number; // override true-peak ceiling (default -1 dBTP)
  applyDialogueNormalization?: boolean;
  preserveOriginalMix?: boolean;
}

export interface SyncMasteringPresetOutput {
  filmId: string;
  preset: MasteringPreset;
  appliedAt: string;
  deliverySpec: {
    integratedLufs: number;
    truePeakDbtp: number;
    loudnessRangeLu: number;
    dialogueGateEnabled: boolean;
  };
  warnings: string[];
}

const STANDARD_LUFS_MAP: Record<DeliveryStandard, number> = {
  EBU_R128: -23,
  ATSC_A85: -24,
  SPOTIFY: -14,
  YOUTUBE: -14,
  APPLE_MUSIC: -16,
  CINEMA_BCHAIN: -23,
  STREAMING_GENERIC: -16,
};

const STANDARD_TRUE_PEAK_MAP: Record<DeliveryStandard, number> = {
  EBU_R128: -1,
  ATSC_A85: -2,
  SPOTIFY: -1,
  YOUTUBE: -1,
  APPLE_MUSIC: -1,
  CINEMA_BCHAIN: -2,
  STREAMING_GENERIC: -1,
};

const STANDARD_LRA_MAP: Record<DeliveryStandard, number> = {
  EBU_R128: 20,
  ATSC_A85: 20,
  SPOTIFY: 8,
  YOUTUBE: 8,
  APPLE_MUSIC: 10,
  CINEMA_BCHAIN: 30,
  STREAMING_GENERIC: 10,
};

@Injectable()
export class SyncMasteringPresetUseCase {
  private readonly logger = new Logger(SyncMasteringPresetUseCase.name);

  constructor(
    @Inject(FILM_REPOSITORY_TOKEN)
    private readonly filmRepository: FilmRepositoryPort,
  ) {}

  async execute(input: SyncMasteringPresetInput): Promise<SyncMasteringPresetOutput> {
    const film = await this.filmRepository.findById(input.filmId);
    if (!film) {
      throw new FilmNotFoundError(`Film ${input.filmId} not found in catalog`);
    }

    const warnings: string[] = [];
    const baseLufs = STANDARD_LUFS_MAP[input.standard];
    const baseTp = STANDARD_TRUE_PEAK_MAP[input.standard];
    const baseLra = STANDARD_LRA_MAP[input.standard];

    const integratedLufs = input.customLoudnessTarget ?? baseLufs;
    const truePeakDbtp = input.customTruePeakDb ?? baseTp;

    if (integratedLufs > -10) {
      warnings.push('Integrated LUFS > -10 dB is non-standard and may cause clipping in lossy codecs.');
    }
    if (truePeakDbtp > -0.3) {
      warnings.push('True-peak ceiling > -0.3 dBTP risks intersample peaks on consumer DACs.');
    }
    if (input.profile === MasteringProfile.CINEMA_DOLBY_ATMOS && integratedLufs !== -23) {
      warnings.push('Dolby Atmos theatrical render is calibrated to -23 LUFS (B-Chain).');
    }

    const loudnessTarget: LoudnessTarget = {
      integratedLufs,
      truePeakDbtp,
      loudnessRangeLu: baseLra,
      dialogueGateEnabled: input.applyDialogueNormalization ?? true,
    };

    const preset = MasteringPreset.create({
      filmId: film.id,
      profile: input.profile,
      deliveryStandard: input.standard,
      loudnessTarget,
      preserveOriginalMix: input.preserveOriginalMix ?? true,
      chainOrder: this.resolveChainOrder(input.profile, input.standard),
    });

    await this.filmRepository.upsertMasteringPreset(film.id, preset);

    this.logger.log(
      `Mastering preset synced film=${film.id} standard=${input.standard} profile=${input.profile} ` +
        `lufs=${integratedLufs} tp=${truePeakDbtp}dBTP lra=${baseLra}LU`,
    );

    return {
      filmId: film.id,
      preset,
      appliedAt: new Date().toISOString(),
      deliverySpec: {
        integratedLufs,
        truePeakDbtp,
        loudnessRangeLu: baseLra,
        dialogueGateEnabled: loudnessTarget.dialogueGateEnabled,
      },
      warnings,
    };
  }

  private resolveChainOrder(
    profile: MasteringProfile,
    standard: DeliveryStandard,
  ): MasteringPreset['chainOrder'] {
    // Theatrical and Atmos deliveries require a different DSP order:
    // loudness normalizer must run after upmix/downmix to preserve spatial cues.
    if (profile === MasteringProfile.CINEMA_DOLBY_ATMOS || standard === 'CINEMA_BCHAIN') {
      return [
        'ROOM_CORRECTION',
        'UPMIX_DOLBY',
        'DYNAMICS_CONTROL',
        'LOUDNESS_NORMALIZER',
        'TRUE_PEAK_LIMITER',
      ];
    }
    return ['ROOM_CORRECTION', 'DYNAMICS_CONTROL', 'LOUDNESS_NORMALIZER', 'TRUE_PEAK_LIMITER'];
  }
}
