'use client';

import { useEffect, useState } from 'react';

const MATERIALS_MEDIA_CACHE_NAME = 'postiz-materials-media-v1';
const inflightBlobTasks = new Map<string, Promise<Blob | null>>();

const normalizeUrl = (value?: string) => String(value || '').trim();

const supportsCacheStorage = () =>
  typeof window !== 'undefined' && typeof window.caches !== 'undefined';

const isDirectMediaUrl = (url: string) =>
  /^https?:\/\//i.test(url) || url.startsWith('/');

const isBlobLikeUrl = (url: string) =>
  url.startsWith('blob:') || url.startsWith('data:');

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
  })()
    .catch(() => null)
    .finally(() => {
      inflightBlobTasks.delete(key);
    });

  inflightBlobTasks.set(key, task);
  return task;
};

export const warmMediaCache = async (url?: string) => {
  const target = normalizeUrl(url);
  if (!target || isBlobLikeUrl(target)) {
    return;
  }
  await getMediaBlob(target);
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
