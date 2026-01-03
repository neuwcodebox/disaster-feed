export type RegionCenter = {
  code: string;
  centerLat: number | null;
  centerLng: number | null;
};

export interface IRegionRepository {
  findCodeByNamePrefix(namePrefix: string): Promise<string | null>;
  findCodeByNamePostfix(namePostfix: string): Promise<string | null>;
  findCentersByCodes(codes: string[]): Promise<Map<string, RegionCenter>>;
}
