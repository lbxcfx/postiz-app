'use client';

import { useEffect, useState } from 'react';

const MATERIALS_MEDIA_CACHE_NAME = 'postiz-materials-media-v1';
const inflightBlobTasks = new Map<string, Promise<Blob | null>>();
const MAX_MEDIA_DOWNLOAD_CONCURRENCY = Math.max(
  1,
  Number(process.env.NEXT_PUBLIC_MATERIALS_MEDIA_DOWNLOAD_CONCURRENCY || 2)
);
let activeMediaDownloads = 0;
const mediaDownloadWaiters: Array<() => void> = [];

const normalizeUrl = (value?: string) => String(value || '').trim();

const supportsCacheStorage = () =>
  typeof window !== 'undefined' && typeof window.caches !== 'undefined';

const isDirectMediaUrl = (url: string) =>
  /^https?:\/\//i.test(url) || url.startsWith('/');

const isBlobLikeUrl = (url: string) =>
  url.startsWith('blob:') || url.startsWith('data:');

const acquireMediaDownloadSlot = async () => {
  if (activeMediaDownloads < MAX_MEDIA_DOWNLOAD_CONCURRENCY) {
    activeMediaDownloads += 1;
    return;
  }
  await new Promise<void>((resolve) => {
    mediaDownloadWaiters.push(() => {
      activeMediaDownloads += 1;
      resolve();
    });
  });
};

const releaseMediaDownloadSlot = () => {
  activeMediaDownloads = Math.max(0, activeMediaDownloads - 1);
  const next = mediaDownloadWaiters.shift();
  if (next) {
    next();
  }
};

const getMediaBlob = async (url: string): Promise<Blob | null> => {
  if (!supportsCacheStorage() || !isDirectMediaUrl(url) || isBlobLikeUrl(url)) {
    return null;
  }

  const key = normalizeUrl(url);
  if (!key) {
    return null;
  }

  const existing = inflightBlobTasks.get(key);
  if (existing) {
    return existing;
  }

  const task = (async () => {
    const cache = await window.caches.open(MATERIALS_MEDIA_CACHE_NAME);
    const req = new Request(key, { method: 'GET' });
    const matched = await cache.match(req, { ignoreVary: true });
    if (matched) {
      return matched.blob();
    }

    await acquireMediaDownloadSlot();
    try {
      const response = await fetch(req, { credentials: 'include' });
      if (!response.ok) {
        return null;
      }

      try {
        await cache.put(req, response.clone());
      } catch {
        // Ignore cache write failures and still return media content.
      }
      return response.blob();
    } finally {
      releaseMediaDownloadSlot();
    }
  })()
    .catch(() => null)
    .finally(() => {
      inflightBlobTasks.delete(key);
    });

  inflightBlobTasks.set(key, task);
  return task;
};

export const warmMediaCache = async (url?: string): Promise<boolean> => {
  const target = normalizeUrl(url);
  if (!target || isBlobLikeUrl(target)) {
    return false;
  }
  const blob = await getMediaBlob(target);
  return Boolean(blob);
};

export const useCachedMediaUrl = (sourceUrl?: string, enabled = true) => {
  const normalized = normalizeUrl(sourceUrl);
  const [resolvedUrl, setResolvedUrl] = useState(normalized);

  useEffect(() => {
    setResolvedUrl(normalized);
    if (!enabled || !normalized || isBlobLikeUrl(normalized)) {
      return;
    }

    let disposed = false;
    let revoke: (() => void) | null = null;

    void (async () => {
      const blob = await getMediaBlob(normalized);
      if (!blob || disposed) {
        return;
      }
      const objectUrl = URL.createObjectURL(blob);
      revoke = () => URL.revokeObjectURL(objectUrl);
      if (disposed) {
        revoke();
        return;
      }
      setResolvedUrl(objectUrl);
    })();

    return () => {
      disposed = true;
      if (revoke) {
        revoke();
      }
    };
  }, [normalized, enabled]);

  return resolvedUrl;
};
