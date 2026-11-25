// Shared types and the colour system (map and interface use the same values).
import type { RainBand } from './analysis.ts';

export type RGBA = [number, number, number, number];
export type Lens = 'pulse' | 'network' | 'taxis';
export type LayerKey = 'stops' | 'rain' | 'taxis' | 'lightning' | 'cams' | 'forecast' | 'grid';

export type Selection =
  | { kind: 'stop'; i: number }
  | { kind: 'gauge'; id: string }
  | { kind: 'cam'; id: string }
  | { kind: 'strike'; i: number }
  | { kind: 'area'; name: string };

export const BAND_RGBA: Record<RainBand, RGBA> = {
  unknown: [70, 92, 100, 140],
  dry: [46, 120, 138, 150],
  light: [47, 168, 255, 235],
  moderate: [47, 224, 255, 245],
  heavy: [178, 140, 255, 255],
  violent: [255, 77, 141, 255],
};

export const BAND_LABEL: Record<RainBand, string> = {
  unknown: 'No reading',
  dry: 'Dry',
  light: 'Light rain',
  moderate: 'Moderate rain',
  heavy: 'Heavy rain',
  violent: 'Violent rain',
};

export const C = {
  cyan: [47, 224, 255, 255] as RGBA,
  taxi: [255, 176, 32, 215] as RGBA,
  cam: [53, 242, 161, 255] as RGBA,
  ground: [255, 77, 77, 255] as RGBA,
  cloud: [255, 176, 32, 255] as RGBA,
  area: [178, 140, 255, 255] as RGBA,
  select: [230, 252, 255, 240] as RGBA,
};

export const css = (c: RGBA, a?: number) => `rgba(${c[0]},${c[1]},${c[2]},${a ?? +(c[3] / 255).toFixed(3)})`;

export const STOP_HEX_RANGE: RGBA[] = [
  [14, 52, 62, 255], [16, 92, 110, 255], [24, 140, 168, 255], [47, 224, 255, 255], [178, 140, 255, 255], [255, 77, 141, 255],
];
export const TAXI_HEX_RANGE: RGBA[] = [
  [52, 34, 8, 255], [96, 60, 12, 255], [150, 94, 16, 255], [214, 140, 24, 255], [255, 176, 32, 255], [255, 226, 150, 255],
];
