import type { PostHealthReqBodyDto } from '../dto/post-health-req-body.dto';
import type { PostHealthResBodyDto } from '../dto/post-health-res-body.dto';

export interface IHealthService {
  createHealth(dto: PostHealthReqBodyDto): Promise<PostHealthResBodyDto>;
}
