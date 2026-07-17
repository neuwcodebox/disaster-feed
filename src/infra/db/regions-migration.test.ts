import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeGeometryAreaCentroid } from './migration-utils/geojson-centroid';
import { parseRegionLine, readRegionRows } from './migrations/0008_update_regions_20260706';
import { buildNewRegionCenters } from './migrations/0009_add_new_region_centroids';

describe('region centroid calculation', () => {
  it('should return an area-weighted centroid for multiple polygons', () => {
    const result = computeGeometryAreaCentroid(
      {
        type: 'MultiPolygon',
        coordinates: [
          [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 1],
              [0, 0],
            ],
          ],
          [
            [
              [2, 2],
              [4, 2],
              [4, 4],
              [2, 4],
              [2, 2],
            ],
          ],
        ],
      },
      'test.geojson',
      0,
    );

    expect(result).not.toBeNull();
    expect(result?.area).toBeCloseTo(5);
    expect(result?.lat).toBeCloseTo(2.5);
    expect(result?.lng).toBeCloseTo(2.5);
  });
});

describe('regions20260706 migration data', () => {
  it('should continue reading after an asynchronous batch operation', async () => {
    const filePath = path.join(process.cwd(), 'data', 'regions20260706.txt');
    let rowCount = 0;

    for await (const _row of readRegionRows(filePath)) {
      rowCount += 1;
      if (rowCount === 500) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }

    expect(rowCount).toBe(53_387);
  });

  it('should parse and validate the complete snapshot', async () => {
    const rows = new Map<string, { name: string; abolished: boolean }>();
    const filePath = path.join(process.cwd(), 'data', 'regions20260706.txt');

    for await (const row of readRegionRows(filePath)) {
      rows.set(row.code, { name: row.name, abolished: row.abolished });
    }

    expect(rows.size).toBe(53_387);
    expect(rows.get('1200000000')).toEqual({ name: '전남광주통합특별시', abolished: false });
    expect(rows.get('2815510300')).toEqual({ name: '인천광역시 영종구 운서동', abolished: false });
    expect(rows.get('4146136000')).toEqual({ name: '경기도 용인시 처인구 양지면', abolished: true });
    expect(rows.get('4159711500')).toEqual({ name: '경기도 화성시 동탄구 여울동', abolished: false });
  });

  it('should reject unknown statuses', () => {
    expect(() => parseRegionLine('1100000000\t서울특별시\t알수없음', 2)).toThrow('invalid 폐지여부');
  });

  it('should trim source columns', () => {
    expect(parseRegionLine('4119200000\t경기도 부천시 원미구 \t존재', 2)).toEqual({
      code: '4119200000',
      name: '경기도 부천시 원미구',
      abolished: false,
    });
  });
});

describe('new region centroid migration data', () => {
  it('should calculate centers only for region codes introduced by the new snapshot', async () => {
    const rows = await buildNewRegionCenters();
    const rowsByCode = new Map(rows.map((row) => [row.code, row]));

    expect(rows).toHaveLength(280);
    expect(rowsByCode.has('4600000000')).toBe(false);
    expect(rowsByCode.has('1200000000')).toBe(true);
    expect(rowsByCode.has('1287000000')).toBe(true);
    expect(rowsByCode.has('2815500000')).toBe(true);
    expect(rowsByCode.has('4146126200')).toBe(true);

    for (const row of rows) {
      expect(Number.isFinite(row.centerLat)).toBe(true);
      expect(Number.isFinite(row.centerLng)).toBe(true);
      expect(row.centerLat).toBeGreaterThan(32);
      expect(row.centerLat).toBeLessThan(39);
      expect(row.centerLng).toBeGreaterThan(124);
      expect(row.centerLng).toBeLessThan(132);
    }
  });
});
