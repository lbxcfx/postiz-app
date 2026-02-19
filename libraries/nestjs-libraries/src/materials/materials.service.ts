import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  MediaCrawlerFileItem,
  MediaCrawlerPlatform,
  MediaCrawlerService,
} from '@gitroom/nestjs-libraries/materials/materials.crawler.service';
import { ioRedis } from '@gitroom/nestjs-libraries/redis/redis.service';

export interface ResolveMaterialJobInput {
  jobId: string;
  platform: MediaCrawlerPlatform;
  startedAt: Date;
  consumedPaths: string[];
}

export interface ResolveMaterialJobOutput {
  file: MediaCrawlerFileItem;
  data: unknown;
}

export interface MaterialsSearchQuery {
  orgId: string;
  platform: MediaCrawlerPlatform;
  keywords: string;
  startPage: number;
  pageLimit?: number;
}

export interface MaterialsCacheEntry {
  queryHash: string;
  resultPath: string;
  count?: number;
  preview?: unknown;
  cachedAt: string;
}

export interface ResolveKeywordResultsInput {
  platform: MediaCrawlerPlatform;
  keywords: string;
  startedAt?: Date;
  includeHistory?: boolean;
}

export interface ResolveKeywordResultsOutput {
  resultPath?: string;
  count: number;
  preview: unknown[];
  data: {
    data: unknown[];
    total: number;
  };
  sourcePaths: string[];
}

@Injectable()
export class MaterialsService {
  private readonly cachePrefix = 'materials:cache:';

  constructor(private readonly crawler: MediaCrawlerService) { }

  async resolveOutputForJob({
    jobId,
    platform,
    startedAt,
    consumedPaths,
  }: ResolveMaterialJobInput): Promise<ResolveMaterialJobOutput | null> {
    const files = await this.crawler.listFiles(platform);
    const preferredFiles = this.filterPreferredFiles(files);
    const file = this.crawler.selectResultFile(
      preferredFiles.length > 0 ? preferredFiles : files,
      jobId,
      startedAt,
      new Set(consumedPaths)
    );

    if (!file) {
      return null;
    }

    const data = await this.crawler.readFile(
      file.path,
      true,
      this.getResultsLimit()
    );
    return { file, data };
  }

  buildQueryHash(query: MaterialsSearchQuery) {
    const normalized = {
      orgId: query.orgId,
      platform: query.platform,
      keywords: query.keywords.trim().toLowerCase(),
    };
    return createHash('md5').update(JSON.stringify(normalized)).digest('hex');
  }

  async getCachedResult(
    query: MaterialsSearchQuery
  ): Promise<MaterialsCacheEntry | null> {
    const queryHash = this.buildQueryHash(query);
    const raw = await ioRedis.get(this.cachePrefix + queryHash);
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as MaterialsCacheEntry;
      if (!parsed?.resultPath) {
        return null;
      }
      return { ...parsed, queryHash };
    } catch (error) {
      return null;
    }
  }

  async storeCachedResult(
    queryHash: string,
    entry: Omit<MaterialsCacheEntry, 'queryHash' | 'cachedAt'> & {
      cachedAt?: string;
    }
  ) {
    if (!queryHash) {
      return;
    }
    if (!this.isPreferredResultPath(entry.resultPath)) {
      return;
    }
    const payload: MaterialsCacheEntry = {
      queryHash,
      resultPath: entry.resultPath,
      count: entry.count,
      preview: entry.preview,
      cachedAt: entry.cachedAt ?? new Date().toISOString(),
    };
    const ttlSeconds = this.getCacheTtlSeconds();
    if (ttlSeconds > 0) {
      await ioRedis.set(
        this.cachePrefix + queryHash,
        JSON.stringify(payload),
        'EX',
        ttlSeconds
      );
      return;
    }
    await ioRedis.set(this.cachePrefix + queryHash, JSON.stringify(payload));
  }

  async clearCachedResult(queryHash: string) {
    if (!queryHash) {
      return;
    }
    await ioRedis.del(this.cachePrefix + queryHash);
  }

  isPreferredResultPath(resultPath?: string) {
    if (!resultPath) {
      return false;
    }
    const lowered = resultPath.toLowerCase();
    if (lowered.includes('comment') || lowered.includes('creator')) {
      return false;
    }
    return true;
  }

  private filterPreferredFiles(files: MediaCrawlerFileItem[]) {
    return files.filter((file) => this.isPreferredResultPath(file.path));
  }

  private getCacheTtlSeconds() {
    return 0; // Permanent cache
  }

  getResultsLimit() {
    const limit = this.parseNumber(process.env.MATERIALS_RESULT_LIMIT, 200);
    return limit > 0 ? limit : 200;
  }

  async resolveKeywordResults(
    input: ResolveKeywordResultsInput
  ): Promise<ResolveKeywordResultsOutput | null> {
    const tokens = this.normalizeKeywords(input.keywords);
    if (tokens.length === 0) {
      return null;
    }

    const files = await this.crawler.listFiles(input.platform);
    const preferredFiles = this.filterPreferredFiles(files);
    const resolveGraceMs = this.parseNumber(
      process.env.MATERIALS_STARTED_AT_GRACE_MS,
      5000
    );
    const startedAtMs = input.startedAt?.getTime() ?? 0;
    const liveCutoff = startedAtMs > 0 ? startedAtMs - resolveGraceMs : 0;
    const matchedFiles = preferredFiles.filter((file) =>
      this.pathMatchesKeywords(file.path, tokens)
    );
    const candidateFiles =
      matchedFiles.length > 0
        ? matchedFiles
        : liveCutoff > 0
          ? preferredFiles.filter(
            (file) => this.extractFileTimestamp(file) >= liveCutoff
          )
          : [];
    if (candidateFiles.length === 0) {
      return null;
    }

    const sorted = candidateFiles
      .map((file) => ({
        file,
        ts: this.extractFileTimestamp(file),
      }))
      .sort((a, b) => b.ts - a.ts);
    const liveLimit = this.parseNumber(
      process.env.MATERIALS_LIVE_FILES_LIMIT,
      8
    );
    const historyLimit = this.parseNumber(
      process.env.MATERIALS_HISTORY_FILES_LIMIT,
      20
    );

    const liveFiles =
      liveCutoff > 0
        ? sorted.filter((entry) => entry.ts >= liveCutoff)
        : sorted;
    const historyFiles =
      liveCutoff > 0
        ? sorted.filter((entry) => entry.ts < liveCutoff)
        : [];

    const selected = this.uniqueByPath([
      ...liveFiles.slice(0, Math.max(liveLimit, 1)).map((entry) => entry.file),
      ...((input.includeHistory ? historyFiles : [])
        .slice(0, Math.max(historyLimit, 1))
        .map((entry) => entry.file)),
    ]);

    const fallbackSelected =
      selected.length > 0
        ? selected
        : sorted
          .slice(0, Math.max(historyLimit, 1))
          .map((entry) => entry.file);
    if (fallbackSelected.length === 0) {
      return null;
    }

    const payloads = await Promise.all(
      fallbackSelected.map(async (file) => {
        try {
          const payload = await this.crawler.readFile(
            file.path,
            true,
            this.getResultsLimit()
          );
          return { file, payload };
        } catch (error) {
          return null;
        }
      })
    );

    const mergedItems = this.mergePayloadItems(
      payloads
        .filter((entry): entry is { file: MediaCrawlerFileItem; payload: unknown } => !!entry)
        .map((entry) => entry.payload)
    );
    if (mergedItems.length === 0) {
      return null;
    }

    const limited = mergedItems.slice(0, this.getResultsLimit());
    return {
      resultPath: fallbackSelected[0]?.path,
      count: mergedItems.length,
      preview: limited.slice(0, 5),
      data: {
        data: limited,
        total: mergedItems.length,
      },
      sourcePaths: fallbackSelected.map((file) => file.path),
    };
  }

  private parseNumber(value: string | undefined, fallback: number) {
    if (!value) {
      return fallback;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private normalizeKeywords(value: string) {
    return String(value || '')
      .split(/[\s,，]+/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
  }

  private pathMatchesKeywords(filePath: string, tokens: string[]) {
    const lowered = String(filePath || '').toLowerCase();
    if (!lowered) {
      return false;
    }
    return tokens.some((token) => lowered.includes(token));
  }

  private extractFileTimestamp(file: MediaCrawlerFileItem) {
    if (file.created_at) {
      const ts = new Date(file.created_at).getTime();
      return Number.isFinite(ts) ? ts : 0;
    }
    if (typeof file.modified_at === 'number') {
      return Math.round(file.modified_at * 1000);
    }
    return 0;
  }

  private uniqueByPath(files: MediaCrawlerFileItem[]) {
    const seen = new Set<string>();
    const result: MediaCrawlerFileItem[] = [];
    for (const file of files) {
      if (!file?.path || seen.has(file.path)) {
        continue;
      }
      seen.add(file.path);
      result.push(file);
    }
    return result;
  }

  private mergePayloadItems(payloads: unknown[]) {
    const orderedItems = payloads.flatMap((payload) =>
      this.extractPayloadItems(payload)
    );
    if (orderedItems.length === 0) {
      return [];
    }

    const seenKeys = new Set<string>();
    const unique: Array<{ item: unknown; ts: number; idx: number }> = [];
    orderedItems.forEach((item, idx) => {
      const key = this.buildItemKey(item, idx);
      if (!key || seenKeys.has(key)) {
        return;
      }
      seenKeys.add(key);
      unique.push({
        item,
        ts: this.extractItemTimestamp(item),
        idx,
      });
    });

    unique.sort((a, b) => {
      if (a.ts !== b.ts) {
        return b.ts - a.ts;
      }
      return a.idx - b.idx;
    });

    return unique.map((entry) => entry.item);
  }

  private extractPayloadItems(payload: unknown) {
    if (Array.isArray(payload)) {
      return payload;
    }
    if (
      payload &&
      typeof payload === 'object' &&
      'data' in payload &&
      Array.isArray((payload as { data?: unknown[] }).data)
    ) {
      return (payload as { data?: unknown[] }).data ?? [];
    }
    return [];
  }

  private buildItemKey(item: unknown, idx: number) {
    if (!item || typeof item !== 'object') {
      return `idx:${idx}`;
    }
    const record = item as Record<string, unknown>;
    const directKeys = [
      'note_id',
      'aweme_id',
      'id',
      'item_id',
      'group_id',
      'video_id',
      'url',
      'note_url',
      'share_url',
      'content_url',
    ];
    for (const key of directKeys) {
      const value = record[key];
      if (value === undefined || value === null) {
        continue;
      }
      const str = String(value).trim();
      if (str) {
        return `${key}:${str}`;
      }
    }

    const fallbackFields = [
      record.title,
      record.note_title,
      record.desc,
      record.nickname,
      record.user_id,
      (record.author as Record<string, unknown> | undefined)?.uid,
      (record.author as Record<string, unknown> | undefined)?.sec_uid,
      (record.author as Record<string, unknown> | undefined)?.user_id,
    ]
      .filter((value) => value !== undefined && value !== null)
      .map((value) => String(value).trim())
      .filter(Boolean);

    if (fallbackFields.length > 0) {
      return `fallback:${fallbackFields.join('|')}`;
    }
    return `idx:${idx}:${JSON.stringify(record).slice(0, 120)}`;
  }

  private extractItemTimestamp(item: unknown) {
    if (!item || typeof item !== 'object') {
      return 0;
    }
    const record = item as Record<string, unknown>;
    const candidates = [
      record.created_at,
      record.create_time,
      record.time,
      record.publish_time,
      record.published_at,
      record.last_update_time,
    ];
    for (const candidate of candidates) {
      const ts = this.parseTimestamp(candidate);
      if (ts > 0) {
        return ts;
      }
    }
    return 0;
  }

  private parseTimestamp(value: unknown) {
    if (value === undefined || value === null) {
      return 0;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value > 1e12 ? Math.round(value) : Math.round(value * 1000);
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return 0;
      }
      const asNum = Number(trimmed);
      if (Number.isFinite(asNum) && asNum > 0) {
        return asNum > 1e12 ? Math.round(asNum) : Math.round(asNum * 1000);
      }
      const asDate = new Date(trimmed).getTime();
      if (Number.isFinite(asDate)) {
        return asDate;
      }
    }
    return 0;
  }
}
