/**
 * Use Case: Get Film Details
 *
 * Retrieves complete details for a single film including:
 * - Core metadata (title, synopsis, runtime, release date)
 * - Cast and crew information
 * - Aggregated ratings and reviews
 * - Similar/related films recommendations
 * - Availability across distribution platforms
 *
 * This is a read-optimized use case designed for the public catalog API.
 */

import { FilmRepository } from '../../domain/repositories/film.repository';
import { FilmNotFoundError } from '../../domain/errors/film-not-found.error';
import { FilmId } from '../../domain/value-objects/film-id.value-object';

export interface CastMemberDTO {
  id: string;
  name: string;
  role: string;
  characterName?: string;
  profileImageUrl?: string;
  order: number;
}

export interface CrewMemberDTO {
  id: string;
  name: string;
  department: string;
  job: string;
  profileImageUrl?: string;
}

export interface RatingBreakdownDTO {
  average: number;
  totalVotes: number;
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
}

export interface PlatformAvailabilityDTO {
  platformId: string;
  platformName: string;
  type: 'subscription' | 'rent' | 'purchase' | 'free';
  price?: number;
  currency?: string;
  quality: 'SD' | 'HD' | '4K' | '8K';
  url: string;
  availableFrom: Date;
  availableTo?: Date;
}

export interface SimilarFilmDTO {
  id: string;
  title: string;
  posterUrl: string;
  releaseYear: number;
  similarityScore: number;
  matchReason: 'genre' | 'director' | 'cast' | 'theme';
}

export interface FilmDetailsDTO {
  id: string;
  title: string;
  originalTitle: string;
  synopsis: string;
  tagline?: string;
  releaseDate: Date;
  releaseYear: number;
  runtimeMinutes: number;
  genres: string[];
  languages: string[];
  countries: string[];
  classification: 'G' | 'PG' | 'PG-13' | 'R' | 'NC-17' | 'L' | '10' | '12' | '14' | '16' | '18';
  status: 'announced' | 'in_production' | 'post_production' | 'released' | 'cancelled';

  posterUrl: string;
  backdropUrl?: string;
  trailerUrl?: string;
  galleryUrls: string[];

  director: string;
  productionCompany: string;
  budget?: number;
  revenue?: number;

  cast: CastMemberDTO[];
  crew: CrewMemberDTO[];

  ratings: RatingBreakdownDTO;
  availability: PlatformAvailabilityDTO[];
  similarFilms: SimilarFilmDTO[];

  metadata: {
    fetchedAt: Date;
    cacheTtlSeconds: number;
    version: number;
  };
}

export interface GetFilmDetailsInput {
  filmId: string;
  includeSimilar?: boolean;
  includeAvailability?: boolean;
  locale?: string;
  requesterId?: string;
}

export class GetFilmDetailsUseCase {
  private static readonly CACHE_TTL_SECONDS = 3600; // 1 hour
  private static readonly MAX_SIMILAR_FILMS = 12;
  private static readonly TOP_CAST_LIMIT = 20;
  private static readonly TOP_CREW_LIMIT = 15;

  constructor(private readonly filmRepository: FilmRepository) {}

  async execute(input: GetFilmDetailsInput): Promise<FilmDetailsDTO> {
    const filmId = FilmId.create(input.filmId);
    const locale = input.locale ?? 'pt-BR';
    const includeSimilar = input.includeSimilar ?? true;
    const includeAvailability = input.includeAvailability ?? true;

    const film = await this.filmRepository.findById(filmId);

    if (!film) {
      throw new FilmNotFoundError(filmId.value);
    }

    if (!film.isVisible() && !input.requesterId) {
      throw new FilmNotFoundError(filmId.value);
    }

    const [cast, crew, ratings, availability, similar] = await Promise.all([
      this.filmRepository.findCastByFilmId(filmId, GetFilmDetailsUseCase.TOP_CAST_LIMIT),
      this.filmRepository.findCrewByFilmId(filmId, GetFilmDetailsUseCase.TOP_CREW_LIMIT),
      this.filmRepository.findRatingBreakdown(filmId),
      includeAvailability
        ? this.filmRepository.findAvailabilityByFilmId(filmId, locale)
        : Promise.resolve([]),
      includeSimilar
        ? this.filmRepository.findSimilarFilms(filmId, GetFilmDetailsUseCase.MAX_SIMILAR_FILMS)
        : Promise.resolve([]),
    ]);

    const mappedCast: CastMemberDTO[] = cast.map((member) => ({
      id: member.id,
      name: member.name,
      role: member.role,
      characterName: member.characterName,
      profileImageUrl: member.profileImageUrl,
      order: member.order,
    }));

    const mappedCrew: CrewMemberDTO[] = crew.map((member) => ({
      id: member.id,
      name: member.name,
      department: member.department,
      job: member.job,
      profileImageUrl: member.profileImageUrl,
    }));

    const mappedAvailability: PlatformAvailabilityDTO[] = availability.map((item) => ({
      platformId: item.platformId,
      platformName: item.platformName,
      type: item.type,
      price: item.price,
      currency: item.currency,
      quality: item.quality,
      url: item.url,
      availableFrom: item.availableFrom,
      availableTo: item.availableTo,
    }));

    const mappedSimilar: SimilarFilmDTO[] = similar.map((item) => ({
      id: item.id,
      title: item.title,
      posterUrl: item.posterUrl,
      releaseYear: item.releaseYear,
      similarityScore: item.similarityScore,
      matchReason: item.matchReason,
    }));

    await this.filmRepository.incrementViewCount(filmId);

    return {
      id: film.id.value,
      title: film.title,
      originalTitle: film.originalTitle,
      synopsis: film.synopsis,
      tagline: film.tagline,
      releaseDate: film.releaseDate,
      releaseYear: film.releaseDate.getFullYear(),
      runtimeMinutes: film.runtimeMinutes,
      genres: film.genres,
      languages: film.languages,
      countries: film.countries,
      classification: film.classification,
      status: film.status,

      posterUrl: film.posterUrl,
      backdropUrl: film.backdropUrl,
      trailerUrl: film.trailerUrl,
      galleryUrls: film.galleryUrls,

      director: film.director,
      productionCompany: film.productionCompany,
      budget: film.budget,
      revenue: film.revenue,

      cast: mappedCast,
      crew: mappedCrew,

      ratings: {
        average: ratings.average,
        totalVotes: ratings.totalVotes,
        distribution: ratings.distribution,
      },
      availability: mappedAvailability,
      similarFilms: mappedSimilar,

      metadata: {
        fetchedAt: new Date(),
        cacheTtlSeconds: GetFilmDetailsUseCase.CACHE_TTL_SECONDS,
        version: film.version,
      },
    };
  }
}
