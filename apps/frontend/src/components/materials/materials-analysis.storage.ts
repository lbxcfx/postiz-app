'use client';

import { MaterialItem } from '@gitroom/frontend/components/materials/materials.types';
import { ViralResult } from '@gitroom/frontend/components/materials/viral-score';

const MATERIALS_ANALYSIS_DATASET_KEY = 'postiz_materials_analysis_dataset_v1';
const MATERIALS_ANALYSIS_DATASET_VERSION = 1;
const MATERIALS_DATASET_LIMIT = 500;
const MATERIALS_LAST_RESULTS_KEY = 'postiz_materials_last_results_v1';
const MATERIALS_LAST_RESULTS_LIMIT = 200;

type MaterialsDatasetSnapshot = {
  version: number;
  savedAt: string;
  items: MaterialItem[];
};

const safeText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length ? text : undefined;
};

const safeNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
};

const safeDate = (value: unknown): string => {
  const fallback = new Date().toISOString();
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? fallback : parsed.toISOString();
};

const parseViralResult = (value: unknown): ViralResult | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const level = safeText(raw.level);
  if (!level || !['viral', 'hot', 'warm', 'normal'].includes(level)) return undefined;
  return {
    score: safeNumber(raw.score) || 0,
    isViral: Boolean(raw.isViral),
    engagementRate: safeNumber(raw.engagementRate),
    followerMultiplier: safeNumber(raw.followerMultiplier) || 1,
    timeMultiplier: safeNumber(raw.timeMultiplier) || 1,
    daysSincePublish: safeNumber(raw.daysSincePublish),
    level: level as ViralResult['level'],
  };
};

const normalizeMaterialItem = (value: unknown): MaterialItem | null => {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const id = safeText(raw.id) || safeText(raw.externalId);
  const platform = safeText(raw.platform);
  const externalId = safeText(raw.externalId) || id;
  if (!id || !platform || !externalId) return null;
  return {
    id,
    platform,
    externalId,
    title: safeText(raw.title),
    desc: safeText(raw.desc),
    coverUrl: safeText(raw.coverUrl),
    contentUrl: safeText(raw.contentUrl),
    authorName: safeText(raw.authorName),
    authorAvatar: safeText(raw.authorAvatar),
    authorUserId: safeText(raw.authorUserId),
    createdAt: safeDate(raw.createdAt),
    likedCount: safeNumber(raw.likedCount),
    collectedCount: safeNumber(raw.collectedCount),
    commentCount: safeNumber(raw.commentCount),
    shareCount: safeNumber(raw.shareCount),
    followerCount: safeNumber(raw.followerCount),
    viralResult: parseViralResult(raw.viralResult),
  };
};

const getDatasetSnapshot = (): MaterialsDatasetSnapshot | null => {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(MATERIALS_ANALYSIS_DATASET_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MaterialsDatasetSnapshot;
    if (!parsed || typeof parsed !== 'object') return null;
    const items = Array.isArray(parsed.items)
      ? parsed.items.map(normalizeMaterialItem).filter((item): item is MaterialItem => Boolean(item))
      : [];
    return {
      version: Number(parsed.version || MATERIALS_ANALYSIS_DATASET_VERSION),
      savedAt: safeDate(parsed.savedAt),
      items,
    };
  } catch {
    return null;
  }
};

export const getMaterialStorageKey = (item: Pick<MaterialItem, 'platform' | 'externalId' | 'id'>) => {
  const platform = (item.platform || 'unknown').trim().toLowerCase();
  const externalId = (item.externalId || item.id || '').trim();
  return `${platform}:${externalId}`;
};

export const persistMaterialDataset = (items: MaterialItem[]) => {
  if (typeof window === 'undefined' || !Array.isArray(items) || items.length === 0) {
    return;
  }
  const existing = getDatasetSnapshot()?.items || [];
  const map = new Map<string, MaterialItem>();

  const merged = [...items, ...existing]
    .map((item) => normalizeMaterialItem(item))
    .filter((item): item is MaterialItem => Boolean(item))
    .slice(0, MATERIALS_DATASET_LIMIT);

  merged.forEach((item) => {
    const key = getMaterialStorageKey(item);
    if (!map.has(key)) {
      map.set(key, item);
    }
  });

  const deduped = Array.from(map.values())
    .sort((a, b) => new Date(b.createdAt).valueOf() - new Date(a.createdAt).valueOf())
    .slice(0, MATERIALS_DATASET_LIMIT);

  const payload: MaterialsDatasetSnapshot = {
    version: MATERIALS_ANALYSIS_DATASET_VERSION,
    savedAt: new Date().toISOString(),
    items: deduped,
  };
  window.localStorage.setItem(MATERIALS_ANALYSIS_DATASET_KEY, JSON.stringify(payload));
};

export const loadMaterialDataset = (): MaterialItem[] => {
  return getDatasetSnapshot()?.items || [];
};

export const persistLastMaterialResults = (items: MaterialItem[]) => {
  if (typeof window === 'undefined' || !Array.isArray(items) || items.length === 0) {
    return;
  }
  const normalized = items
    .map((item) => normalizeMaterialItem(item))
    .filter((item): item is MaterialItem => Boolean(item))
    .slice(0, MATERIALS_LAST_RESULTS_LIMIT);
  if (!normalized.length) {
    return;
  }
  const payload: MaterialsDatasetSnapshot = {
    version: MATERIALS_ANALYSIS_DATASET_VERSION,
    savedAt: new Date().toISOString(),
    items: normalized,
  };
  window.localStorage.setItem(MATERIALS_LAST_RESULTS_KEY, JSON.stringify(payload));
};

export const loadLastMaterialResults = (): MaterialItem[] => {
  if (typeof window === 'undefined') return [];
  const raw = window.localStorage.getItem(MATERIALS_LAST_RESULTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as MaterialsDatasetSnapshot;
    const items = Array.isArray(parsed.items)
      ? parsed.items
          .map((item) => normalizeMaterialItem(item))
          .filter((item): item is MaterialItem => Boolean(item))
      : [];
    return items;
  } catch {
    return [];
  }
};

export const findMaterialFromDataset = (storageKey: string): MaterialItem | null => {
  if (!storageKey) return null;
  const normalizedKey = decodeURIComponent(storageKey).trim();
  if (!normalizedKey) return null;
  const dataset = loadMaterialDataset();
  return dataset.find((item) => getMaterialStorageKey(item) === normalizedKey) || null;
};
