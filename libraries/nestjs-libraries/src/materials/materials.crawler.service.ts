import { Injectable } from '@nestjs/common';

export type MediaCrawlerPlatform = 'xhs' | 'dy';
export type MediaCrawlerLoginType = 'qrcode' | 'phone' | 'cookie';
export type MediaCrawlerCrawlerType = 'search' | 'detail' | 'creator';

export interface MediaCrawlerStartPayload {
  platform: MediaCrawlerPlatform;
  crawler_type: MediaCrawlerCrawlerType;
  keywords?: string;
  client_job_id?: string;
  login_type?: MediaCrawlerLoginType;
  save_option?: 'json';
  start_page?: number;
  crawl_count?: number;
  enable_comments?: boolean;
  enable_sub_comments?: boolean;
  headless?: boolean; // Auto-determined based on login state
  login_phone?: string;
}

export interface MediaCrawlerStartResponse {
  status: string;
  accepted_at?: string;
  client_job_id?: string;
}

export interface MediaCrawlerStatusResponse {
  status: string;
  platform?: string;
  crawler_type?: string;
  started_at?: string;
  error_message?: string | null;
  client_job_id?: string;
}

export interface MediaCrawlerFileItem {
  path: string;
  created_at?: string;
  modified_at?: number;
  client_job_id?: string;
}

export interface MediaCrawlerLogEntry {
  id: number;
  timestamp: string;
  level: string;
  message: string;
  client_job_id?: string;
}

interface MediaCrawlerFilesResponse {
  files: MediaCrawlerFileItem[];
}

interface MediaCrawlerLogsResponse {
  logs: MediaCrawlerLogEntry[];
}

interface MediaCrawlerSmsCodePayload {
  platform: MediaCrawlerPlatform;
  login_phone: string;
  sms_code: string;
  client_job_id?: string;
}

@Injectable()
export class MediaCrawlerService {
  private readonly baseUrl =
    process.env.MEDIACRAWLER_API_URL || 'http://127.0.0.1:8081';
  private readonly apiKey = process.env.MEDIACRAWLER_API_KEY || '';
  private readonly allowStaleResultFallback =
    process.env.MATERIALS_ALLOW_STALE_RESULT_FALLBACK === 'true';

  private buildHeaders() {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private normalizeUrl(path: string) {
    const trimmed = this.baseUrl.replace(/\/+$/, '');
    return `${trimmed}${path}`;
  }

  private async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `MediaCrawler request failed (${response.status}): ${text}`
      );
    }
    return response.json() as Promise<T>;
  }

  async startCrawl(payload: MediaCrawlerStartPayload) {
    return this.fetchJson<MediaCrawlerStartResponse>(
      this.normalizeUrl('/api/crawler/start'),
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(payload),
      }
    );
  }

  async submitSmsCode(payload: MediaCrawlerSmsCodePayload) {
    return this.fetchJson<{ status: string; message?: string }>(
      this.normalizeUrl('/api/crawler/sms-code'),
      {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(payload),
      }
    );
  }

  async getStatus() {
    return this.fetchJson<MediaCrawlerStatusResponse>(
      this.normalizeUrl('/api/crawler/status'),
      {
        headers: this.buildHeaders(),
      }
    );
  }

  async stopCrawl() {
    return this.fetchJson<{ status: string }>(
      this.normalizeUrl('/api/crawler/stop'),
      {
        method: 'POST',
        headers: this.buildHeaders(),
      }
    );
  }

  async listFiles(platform: MediaCrawlerPlatform) {
    const url = this.normalizeUrl(
      `/api/data/files?platform=${encodeURIComponent(
        platform
      )}&file_type=json`
    );
    const response = await this.fetchJson<MediaCrawlerFilesResponse>(url, {
      headers: this.buildHeaders(),
    });
    return response.files ?? [];
  }

  async readFile(filePath: string, preview = true, limit = 100) {
    const params = `preview=${preview ? 'true' : 'false'}&limit=${limit}`;
    const url = this.normalizeUrl(`/api/data/files/${filePath}?${params}`);
    return this.fetchJson<unknown>(url, {
      headers: this.buildHeaders(),
    });
  }

  async getLogs(limit = 200) {
    const url = this.normalizeUrl(`/api/crawler/logs?limit=${limit}`);
    const response = await this.fetchJson<MediaCrawlerLogsResponse>(url, {
      headers: this.buildHeaders(),
    });
    return response.logs ?? [];
  }

  /**
   * Check if valid login cookies exist for a platform.
   * Used to determine whether to use headless mode:
   * - If valid login exists: use headless mode (no browser window)
   * - If no valid login: use headed mode (show browser for QR code login)
   */
  async checkLoginStatus(platform: MediaCrawlerPlatform): Promise<{
    has_valid_login: boolean;
    recommendation: 'headless' | 'headed';
    message: string;
    cookies_found?: string[];
    user_data_dir?: string;
    cookies_db?: string;
    cdp_mode?: boolean;
  }> {
    try {
      const url = this.normalizeUrl(`/api/crawler/login-status/${platform}`);
      return await this.fetchJson(url, {
        headers: this.buildHeaders(),
      });
    } catch (error) {
      // If check fails, default to headed mode to allow login
      return {
        has_valid_login: false,
        recommendation: 'headed',
        message: 'Unable to check login status, defaulting to headed mode',
      };
    }
  }

  selectResultFile(
    files: MediaCrawlerFileItem[],
    jobId: string,
    startedAt: Date,
    consumedPaths: Set<string>
  ) {
    const available = files.filter((file) => !consumedPaths.has(file.path));
    const directMatches = available.filter(
      (file) =>
        file.client_job_id === jobId ||
        this.pathContainsJobId(file.path, jobId)
    );
    const directMatch = this.pickPreferredFile(directMatches);
    if (directMatch) {
      return directMatch;
    }

    const candidates = available.filter((file) => {
      const fileTime = this.extractFileTimestamp(file);
      if (!fileTime) {
        return false;
      }
      return fileTime >= startedAt.getTime();
    });

    return (
      this.pickPreferredFile(candidates) ||
      (this.allowStaleResultFallback
        ? this.pickPreferredFile(available)
        : null)
    );
  }

  private extractFileTimestamp(file: MediaCrawlerFileItem) {
    if (file.created_at) {
      return new Date(file.created_at).getTime();
    }
    if (typeof file.modified_at === 'number') {
      return Math.round(file.modified_at * 1000);
    }
    return 0;
  }

  private pickPreferredFile(files: MediaCrawlerFileItem[]) {
    if (!files.length) {
      return null;
    }
    const ranked = files
      .map((file) => ({
        file,
        score: this.scoreFile(file),
        ts: this.extractFileTimestamp(file),
      }))
      .sort((a, b) => {
        if (a.score !== b.score) {
          return b.score - a.score;
        }
        return b.ts - a.ts;
      });
    return ranked[0]?.file ?? null;
  }

  private scoreFile(file: MediaCrawlerFileItem) {
    const path = (file.path || '').toLowerCase();
    if (!path) {
      return 0;
    }
    if (path.includes('search_contents')) {
      return 4;
    }
    if (path.includes('contents')) {
      return 3;
    }
    if (path.includes('content')) {
      return 2;
    }
    if (path.includes('comments') || path.includes('comment')) {
      return -1;
    }
    if (path.includes('creators') || path.includes('creator')) {
      return -2;
    }
    return 0;
  }

  private pathContainsJobId(path: string, jobId: string) {
    if (!path || !jobId) {
      return false;
    }
    const lowerPath = path.toLowerCase();
    const lowerJobId = jobId.toLowerCase();
    return (
      lowerPath.includes(`job_${lowerJobId}__`) ||
      lowerPath.includes(`/${lowerJobId}__`) ||
      lowerPath.includes(`\\${lowerJobId}__`)
    );
  }

  /**
   * Batch fetch user profile information (fan counts, etc.)
   * Used by viral scoring for secondary enrichment.
   */
  async getUserProfiles(
    platform: MediaCrawlerPlatform,
    userIds: string[]
  ): Promise<UserProfileResponse> {
    if (!userIds.length) {
      return { platform, profiles: [], fetched: 0, failed: 0 };
    }
    try {
      const url = this.normalizeUrl('/api/crawler/user-profiles');
      return await this.fetchJson<UserProfileResponse>(url, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          platform,
          user_ids: userIds.slice(0, 20), // Limit to avoid abuse
        }),
      });
    } catch (error) {
      // Return empty on failure - non-critical feature
      return { platform, profiles: [], fetched: 0, failed: userIds.length };
    }
  }
}

export interface UserProfileInfo {
  user_id: string;
  nickname?: string;
  fans?: number;
  follows?: number;
  interaction?: number;
  avatar?: string;
  desc?: string;
  error?: string;
}

export interface UserProfileResponse {
  platform: string;
  profiles: UserProfileInfo[];
  fetched: number;
  failed: number;
}
