export type StationInfo = {
  code: number;
  startDate: string;
  endDate: string | null;
  name: string;
  address: string | null;
  office: string | null;
  lat: number | null;
  lng: number | null;
  altitudeM: number | null;
  barometerM: number | null;
  thermometerM: number | null;
  anemometerM: number | null;
  rainGaugeM: number | null;
};

export interface IStationRepository {
  findByCode(code: number): Promise<StationInfo | null>;
}
