/**
 * Render Theatrical Mix Use Case
 * --------------------------------
 * Mixdown cinematográfico para salas Dolby/IMAX/publicidade broadcast.
 * Aplica loudness normalization ITU-R BS.1770-4 (LUFS), true-peak limiting
 * (dBTP) e dialnorm propagation para o catálogo pub-films.
 *
 * Responsabilidade: orquestrar o pipeline DSP (analyze -> sum -> limit -> verify)
 * preservando a integridade do asset master e gerando entregáveis prontos
 * para DCP (Digital Cinema Package), OTT (streaming) e trailers broadcast.
 */

import { AudioAsset } from '../../domain/entities/audio-asset.entity';
import { LoudnessProfile, LoudnessTarget } from '../../domain/value-objects/loudness-profile.vo';
import { TheatricalMixSpecification } from '../../domain/value-objects/theatrical-mix-specification.vo';
import { MixRenderJob } from '../../domain/entities/mix-render-job.entity';

/**
- * Parâmetros de entrada do caso de uso.
- */
export interface RenderTheatricalMixInput {
  filmId: string;
  stemGroupId: string;          // grupo de stems (dialogue / music / fx / ambience)
  target: LoudnessTarget;       // THEATRICAL | STREAMING | TRAILER_BROADCAST
  dialnorm?: number;            // diálogo alvo em LUFS (default conforme target)
  truePeakCeilingDbtp?: number; // teto true-peak (default -2 dBTP para cinema)
  sampleRateHz?: number;        // 48000 padrão cinema
  bitDepth?: number;            // 24 padrão
  preserveDynamicRange?: boolean;
  deliverableFormats?: Array<'DOLBY_DCP' | 'IMAX_ENHANCED' | 'STEREO_OTT' | 'TRAILER_BROADCAST'>;
}

/**
- * Resultado consolidado do render.
- */
export interface RenderTheatricalMixOutput {
  jobId: string;
  filmId: string;
  status: 'COMPLETED' | 'PARTIAL' | 'FAILED';
  measuredLoudness: LoudnessProfile;
  deliverables: Array<{
    format: string;
    uri: string;
    checksumSha256: string;
    peakDbtp: number;
    integratedLufs: number;
    truePeakCompliant: boolean;
  }>;
  renderedAt: string;
  durationMs: number;
}

/**
- * Exceção de domínio para loudness fora de conformidade.
- */
export class LoudnessComplianceError extends Error {
  constructor(
    public readonly measuredLufs: number,
    public readonly targetLufs: number,
    public readonly tolerance: number,
  ) {
    super(
      `Loudness fora de conformidade: medido ${measuredLufs.toFixed(2)} LUFS, ` +
      `alvo ${targetLufs.toFixed(2)} LUFS (tolerância ±${tolerance} LU).`,
    );
    this.name = 'LoudnessComplianceError';
  }
}

/**
- * Porta de infraestrutura para renderização DSP.
- * Em produção, adaptador concreto (ffmpeg + loudnorm e sox + custom brick-wall limiter).
- */
export interface TheatricalRenderEnginePort {
  analyzeLoudness(assetUri: string): Promise<LoudnessProfile>;
  sumStems(stemUris: string[], gainDb: number[]): Promise<string>;
  applyTruePeakLimiter(inputUri: string, ceilingDbtp: number): Promise<string>;
  transcodeDelivery(inputUri: string, format: string, sampleRateHz: number, bitDepth: number): Promise<{ uri: string; checksumSha256: string }>;
  writeArtifact(uri: string, data: Buffer): Promise<void>;
}

/**
- * Caso de uso principal.
- */
export class RenderTheatricalMixUseCase {
  constructor(
    private readonly engine: TheatricalRenderEnginePort,
    private readonly auditTrail: Array<{ ts: string; step: string; payload?: unknown }> = [],
  ) {}

  async execute(input: RenderTheatricalMixInput): Promise<RenderTheatricalMixOutput> {
    const startedAt = Date.now();
    const spec = TheatricalMixSpecification.for(input.target, {
      dialnorm: input.dialnorm,
      truePeakCeilingDbtp: input.truePeakCeilingDbtp,
      sampleRateHz: input.sampleRateHz,
      bitDepth: input.bitDepth,
    });

    this.audit({ step: 'init', payload: { filmId: input.filmId, target: input.target, spec: spec.toJSON() } });

    // 1. Validar stems de entrada (5.1 / 7.1.4)
    const stems = await this.loadStemGroup(input.stemGroupId);
    if (stems.length < 4) {
      throw new Error(`Stem group ${input.stemGroupId} insuficiente: ${stems.length} stems encontrados, mínimo 4.`);
    }

    // 2. Pré-análise: medir loudness de cada stem isoladamente
    const stemProfiles: AudioAsset[] = [];
    for (const stem of stems) {
      const profile = await this.engine.analyzeLoudness(stem.uri);
      this.audit({ step: 'stem-analysis', payload: { stemId: stem.id, profile: profile.toJSON() } });
      stemProfiles.push(AudioAsset.hydrate({ ...stem, measuredLoudness: profile }));
    }

    // 3. Calcular gains de mix com base nos targets
    const mixGains = this.computeMixGains(stemProfiles, spec);

    // 4. Sum dos stems (mix principal)
    const mixedUri = await this.engine.sumStems(stems.map(s => s.uri), mixGains);
    this.audit({ step: 'mix-sum', payload: { outputUri: mixedUri, gainsDb: mixGains } });

    // 5. True-peak limiting
    const limitedUri = await this.engine.applyTruePeakLimiter(mixedUri, spec.truePeakCeilingDbtp);

    // 6. Medir loudness final e validar conformidade
    const finalProfile = await this.engine.analyzeLoudness(limitedUri);
    this.audit({ step: 'final-analysis', payload: finalProfile.toJSON() });

    const tolerance = spec.toleranceLufs;
    if (Math.abs(finalProfile.integratedLufs - spec.targetLufs) > tolerance) {
      throw new LoudnessComplianceError(finalProfile.integratedLufs, spec.targetLufs, tolerance);
    }

    // 7. Gerar entregáveis nos formatos solicitados
    const formats = input.deliverableFormats ?? spec.defaultDeliverables;
    const deliverables: RenderTheatricalMixOutput['deliverables'] = [];

    for (const format of formats) {
      const transcode = await this.engine.transcodeDelivery(
        limitedUri,
        format,
        spec.sampleRateHz,
        spec.bitDepth,
      );
      deliverables.push({
        format,
        uri: transcode.uri,
        checksumSha256: transcode.checksumSha256,
        peakDbtp: finalProfile.truePeakDbtp,
        integratedLufs: finalProfile.integratedLufs,
        truePeakCompliant: finalProfile.truePeakDbtp <= spec.truePeakCeilingDbtp,
      });
      this.audit({ step: 'deliverable', payload: { format, uri: transcode.uri } });
    }

    const job = MixRenderJob.create({
      filmId: input.filmId,
      target: input.target,
      measuredLoudness: finalProfile,
      deliverablesCount: deliverables.length,
    });

    return {
      jobId: job.id,
      filmId: input.filmId,
      status: 'COMPLETED',
      measuredLoudness: finalProfile,
      deliverables,
      renderedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Calcula ganho (dB) por stem para alcançar o loudness alvo preservando
   * a relação diálogo/music/FX (recomendação: dialogue -2 LU acima de music/FX).
   */
  private computeMixGains(stems: AudioAsset[], spec: TheatricalMixSpecification): number[] {
    const baseLufs = stems.reduce((acc, s) => acc + s.measuredLoudness.integratedLufs, 0) / stems.length;
    const offset = spec.targetLufs - baseLufs;

    return stems.map((s) => {
      const channelPriority = s.channel === 'dialogue' ? spec.dialoguePriorityDb : 0;
      return Number((offset + channelPriority).toFixed(2));
    });
  }

  private async loadStemGroup(stemGroupId: string): Promise<Array<{ id: string; uri: string; channel: 'dialogue' | 'music' | 'fx' | 'ambience' }>> {
    // Em produção: repositório de stems (S3/GCS) + manifesto JSON.
    return [
      { id: `${stemGroupId}-dlg`, uri: `s3://pub-films-stems/${stemGroupId}/dialogue.wav`, channel: 'dialogue' },
      { id: `${stemGroupId}-mus`, uri: `s3://pub-films-stems/${stemGroupId}/music.wav`, channel: 'music' },
      { id: `${stemGroupId}-fx`,  uri: `s3://pub-films-stems/${stemGroupId}/fx.wav`, channel: 'fx' },
      { id: `${stemGroupId}-amb`, uri: `s3://pub-films-stems/${stemGroupId}/ambience.wav`, channel: 'ambience' },
    ];
  }

  private audit(entry: { step: string; payload?: unknown }): void {
    this.auditTrail.push({ ts: new Date().toISOString(), ...entry });
  }
}
