import { createReadStream } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const schemaPosition = z.tuple([z.number(), z.number()]);
const schemaLinearRing = z.array(schemaPosition);
const schemaPolygonCoordinates = z.array(schemaLinearRing);
const schemaMultiPolygonCoordinates = z.array(schemaPolygonCoordinates);

export const schemaGeoJsonGeometry = z.union([
  z.object({
    type: z.literal('Polygon'),
    coordinates: schemaPolygonCoordinates,
  }),
  z.object({
    type: z.literal('MultiPolygon'),
    coordinates: schemaMultiPolygonCoordinates,
  }),
]);

type PolygonCoordinates = z.infer<typeof schemaPolygonCoordinates>;
type MultiPolygonCoordinates = z.infer<typeof schemaMultiPolygonCoordinates>;
export type GeoJsonGeometry = z.infer<typeof schemaGeoJsonGeometry>;

export type GeometryAreaCentroid = {
  area: number;
  lat: number;
  lng: number;
};

type PointAccumulator = {
  count: number;
  sumLat: number;
  sumLng: number;
};

class NoCoordinatesError extends Error {
  constructor() {
    super('geometry has no coordinates');
    this.name = 'NoCoordinatesError';
  }
}

export function computeGeometryCentroid(
  geometry: GeoJsonGeometry,
  fileName: string,
  index: number,
): { lat: number; lng: number } | null {
  const result = computeGeometryAreaCentroid(geometry, fileName, index);
  return result ? { lat: result.lat, lng: result.lng } : null;
}

export function computeGeometryAreaCentroid(
  geometry: GeoJsonGeometry,
  fileName: string,
  index: number,
): GeometryAreaCentroid | null {
  let result: GeometryAreaCentroid;
  try {
    result =
      geometry.type === 'Polygon'
        ? computePolygonCentroidWithArea(geometry.coordinates)
        : computeMultiPolygonCentroidWithArea(geometry.coordinates);
  } catch (error) {
    if (error instanceof NoCoordinatesError) {
      return null;
    }
    const message = error instanceof Error ? error.message : 'unknown error';
    throw new Error(`${fileName} centroid calculation failed at index ${index}: ${message}`);
  }

  if (!Number.isFinite(result.area) || !Number.isFinite(result.lat) || !Number.isFinite(result.lng)) {
    throw new Error(`${fileName} centroid calculation failed at index ${index}`);
  }

  return result;
}

function computeMultiPolygonCentroidWithArea(coordinates: MultiPolygonCoordinates): GeometryAreaCentroid {
  const fallback = createPointAccumulator();
  let areaSum = 0;
  let weightedLat = 0;
  let weightedLng = 0;

  for (const polygon of coordinates) {
    appendPolygonPoints(fallback, polygon);
    const polygonResult = computePolygonCentroidWithArea(polygon);
    if (polygonResult.area === 0) {
      continue;
    }

    areaSum += polygonResult.area;
    weightedLat += polygonResult.lat * polygonResult.area;
    weightedLng += polygonResult.lng * polygonResult.area;
  }

  if (areaSum !== 0) {
    return {
      area: areaSum,
      lat: weightedLat / areaSum,
      lng: weightedLng / areaSum,
    };
  }

  return { area: 0, ...computeAveragePoint(fallback) };
}

function computePolygonCentroidWithArea(coordinates: PolygonCoordinates): GeometryAreaCentroid {
  const fallback = createPointAccumulator();
  let areaSum = 0;
  let weightedLat = 0;
  let weightedLng = 0;

  for (let ringIndex = 0; ringIndex < coordinates.length; ringIndex += 1) {
    const ring = coordinates[ringIndex];
    appendRingPoints(fallback, ring);
    const ringResult = computeRingCentroid(ring);
    if (ringResult.area === 0) {
      continue;
    }

    const ringArea = ringIndex === 0 ? Math.abs(ringResult.area) : -Math.abs(ringResult.area);
    areaSum += ringArea;
    weightedLat += ringResult.lat * ringArea;
    weightedLng += ringResult.lng * ringArea;
  }

  if (areaSum !== 0) {
    return {
      area: areaSum,
      lat: weightedLat / areaSum,
      lng: weightedLng / areaSum,
    };
  }

  return { area: 0, ...computeAveragePoint(fallback) };
}

function computeRingCentroid(ring: z.infer<typeof schemaLinearRing>): GeometryAreaCentroid {
  if (ring.length < 3) {
    return { area: 0, lat: 0, lng: 0 };
  }

  let area2 = 0;
  let centerLat = 0;
  let centerLng = 0;

  for (let index = 0; index < ring.length; index += 1) {
    const [x0, y0] = ring[index];
    const [x1, y1] = ring[(index + 1) % ring.length];
    const cross = x0 * y1 - x1 * y0;
    area2 += cross;
    centerLng += (x0 + x1) * cross;
    centerLat += (y0 + y1) * cross;
  }

  if (area2 === 0) {
    return { area: 0, lat: 0, lng: 0 };
  }

  const divisor = 3 * area2;
  return {
    area: area2 / 2,
    lat: centerLat / divisor,
    lng: centerLng / divisor,
  };
}

function createPointAccumulator(): PointAccumulator {
  return { count: 0, sumLat: 0, sumLng: 0 };
}

function appendPolygonPoints(accumulator: PointAccumulator, polygon: PolygonCoordinates): void {
  for (const ring of polygon) {
    appendRingPoints(accumulator, ring);
  }
}

function appendRingPoints(accumulator: PointAccumulator, ring: z.infer<typeof schemaLinearRing>): void {
  for (const position of ring) {
    accumulator.sumLng += position[0];
    accumulator.sumLat += position[1];
    accumulator.count += 1;
  }
}

function computeAveragePoint(accumulator: PointAccumulator): { lat: number; lng: number } {
  if (accumulator.count === 0) {
    throw new NoCoordinatesError();
  }

  return {
    lat: accumulator.sumLat / accumulator.count,
    lng: accumulator.sumLng / accumulator.count,
  };
}

export async function* readGeoJsonFeatureObjects(filePath: string): AsyncGenerator<string> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  let started = false;
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let current = '';

  for await (const chunk of stream) {
    for (let index = 0; index < chunk.length; index += 1) {
      const char = chunk[index];

      if (!started) {
        if (char === '[') {
          started = true;
        }
        continue;
      }

      if (depth === 0) {
        if (char === '{') {
          depth = 1;
          current = '{';
        } else if (char === ']') {
          return;
        }
        continue;
      }

      current += char;

      if (inString) {
        if (escapeNext) {
          escapeNext = false;
          continue;
        }
        if (char === '\\') {
          escapeNext = true;
          continue;
        }
        if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === '{') {
        depth += 1;
        continue;
      }

      if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          yield current;
          current = '';
        }
      }
    }
  }

  if (depth !== 0 || inString) {
    throw new Error(`${path.basename(filePath)} parse failed: unexpected end of file.`);
  }
}
