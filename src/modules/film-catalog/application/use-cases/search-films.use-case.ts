import { Injectable } from '@nestjs/common';
import { FilmRepository } from '../../domain/repositories/film.repository';
import { Film } from '../../domain/entities/film.entity';
import { SearchCriteria } from '../dtos/search-criteria.dto';

@Injectable()
export class SearchFilmsUseCase {
  constructor(private readonly filmRepository: FilmRepository) {}

  async execute(
    criteria: SearchCriteria,
  ): Promise<{ data: Film[]; total: number; page: number; limit: number }> {
    const { query, genre, year, director, page = 1, limit = 20, sortBy = 'title', sortOrder = 'ASC' } = criteria;

    const skip = (page - 1) * limit;

    const sort: Record<string, 1 | -1> = { [sortBy]: sortOrder === 'ASC' ? 1 : -1 };

    const filters: Record<string, unknown> = {};
    if (genre) filters.genre = genre;
    if (year) filters.year = year;
    if (director) filters.director = director;

    const [data, total] = await this.filmRepository.search({
      query,
      filters,
      skip,
      take: limit,
      sort,
    });

    return { data, total, page, limit };
  }
}
