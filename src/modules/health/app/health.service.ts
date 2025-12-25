import { inject, injectable } from 'inversify';
import { HealthDeps } from '../domain/dep/health.dep';
import type { PostHealthReqBodyDto } from '../domain/dto/post-health-req-body.dto';
import type { PostHealthResBodyDto } from '../domain/dto/post-health-res-body.dto';
import type { IHealthRepository } from '../domain/port/health-repo.interface';
import type { IHealthService } from '../domain/port/health-service.interface';

@injectable()
export class HealthService implements IHealthService {
  constructor(
    @inject(HealthDeps.HealthRepo)
    private readonly healthRepository: IHealthRepository,
  ) {}

  public async createHealth(dto: PostHealthReqBodyDto): Promise<PostHealthResBodyDto> {
    const health = await this.healthRepository.createHealth({
      message: dto.message,
      createdAt: new Date().toISOString(),
    });
    return {
      id: health.id,
      message: health.message,
      createdAt: new Date(health.createdAt).getTime(),
    };
  }
}
