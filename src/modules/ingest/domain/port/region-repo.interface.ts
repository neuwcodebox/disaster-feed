export interface IRegionRepository {
  findCodeByNamePrefix(namePrefix: string): Promise<string | null>;
}
