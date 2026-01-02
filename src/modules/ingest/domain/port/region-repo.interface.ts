export interface IRegionRepository {
  findCodeByNamePrefix(namePrefix: string): Promise<string | null>;
  findCodeByNamePostfix(namePostfix: string): Promise<string | null>;
}
