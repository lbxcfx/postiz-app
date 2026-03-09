
"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { MaterialsSearch } from "./materials-search.component";
import { MaterialsResults } from "./materials-results.component";
import { MaterialsViralSettings } from "./materials-viral-settings.component";
import {
  ViralThresholds,
  DEFAULT_VIRAL_THRESHOLDS,
  calculateViralScore,
} from "./viral-score";
import { useFetch } from "@gitroom/helpers/utils/custom.fetch";
import { useVariables } from "@gitroom/react/helpers/variable.context";
import { useRouter } from "next/navigation";
import { MaterialItem } from "./materials.types";
import {
  getMaterialStorageKey,
  loadLastMaterialResults,
  persistLastMaterialResults,
  persistMaterialDataset,
} from "./materials-analysis.storage";
import { warmMediaCache } from "./materials-media-cache";

// ────────────────── Helpers ──────────────────

const resolveFirstUrl = (value: any): string | undefined => {
  if (!value) return undefined;
  if (Array.isArray(value)) {
    const first = value[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object")
      return first.url || first.cover || first.cover_url || first.image;
    return undefined;
  }
  if (typeof value === "string") {
    if (value.includes(",") && value.startsWith("http")) {
      return value.split(",")[0]?.trim();
    }
    return value;
  }
  return undefined;
};

const normalizeXhsCoverUrl = (value?: string) => {
  if (!value) return value;
  return value.replace(
    /!nd_dft_wgth_(webp|jpg)_\d+/i,
    "!nd_dft_wgth_$1_1"
  );
};

const toIsoDate = (value: any) => {
  if (!value) return new Date().toISOString();
  const num = typeof value === "string" ? Number(value) : value;
  if (typeof num === "number" && Number.isFinite(num)) {
    const millis = num < 1e12 ? num * 1000 : num;
    return new Date(millis).toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? new Date().toISOString()
    : parsed.toISOString();
};

const safeInt = (v: any): number => {
  if (v === undefined || v === null || v === "") return 0;
  if (typeof v === "number") {
    return Number.isFinite(v) ? Math.round(v) : 0;
  }

  const raw = String(v).trim();
  if (!raw) return 0;

  const normalized = raw.replace(/,/g, "").replace(/\s+/g, "").replace(/＋/g, "+");
  const compact = normalized.replace(/\+/g, "");
  const match = compact.match(/^(-?\d+(?:\.\d+)?)([亿万千wWkKmM])?/);
  if (match) {
    const base = Number(match[1]);
    if (!Number.isFinite(base)) return 0;
    const unit = match[2] || "";
    const multiplier =
      unit === "亿"
        ? 100000000
        : unit === "万"
          ? 10000
          : unit === "千"
            ? 1000
            : unit === "w" || unit === "W"
              ? 10000
              : unit === "k" || unit === "K"
                ? 1000
                : unit === "m" || unit === "M"
                  ? 1000000
                  : 1;
    return Math.max(0, Math.round(base * multiplier));
  }

  const parsed = Number(compact);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
};

const extractResultsItems = (payload: any) => {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.items)) return payload.items;
  return [];
};

const normalizeQrBase64 = (value?: string) => {
  if (!value || typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("data:image")) {
    const comma = trimmed.indexOf(",");
    return comma >= 0 ? trimmed.slice(comma + 1) : trimmed;
  }
  return trimmed;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const needsProxy = (url: string): boolean => {
  if (!url) return false;
  const proxyDomains = [
    "xhscdn.com",
    "xiaohongshu.com",
    "douyinpic.com",
    "douyinvod.com",
    "byteimg.com",
    "pstatp.com",
  ];
  try {
    const parsed = new URL(url);
    return proxyDomains.some((domain) => parsed.hostname.includes(domain));
  } catch {
    return false;
  }
};

const getProxiedUrl = (
  url: string | undefined,
  platform: string,
  backendUrl: string
) => {
  if (!url || !needsProxy(url) || !backendUrl) return url || "";
  const encodedUrl = encodeURIComponent(url);
  return `${backendUrl}/materials/image-proxy?url=${encodedUrl}&platform=${platform}`;
};

const isLikelyVideoUrl = (url?: string): boolean => {
  if (!url) return false;
  return /\.(mp4|webm|mov|m3u8)(\?|$)/i.test(url);
};

// ────────────────── Data Mapping ──────────────────

const mapToMaterialItems = (items: any[], platform: string): MaterialItem[] => {
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => {
    if (platform === "xhs") {
      const noteCard = item.note_card || {};
      const interactInfo = item.interact_info || noteCard.interact_info || {};
      const noteId = item.note_id || item.id || String(index);
      const cover =
        resolveFirstUrl(item.image_list) ||
        resolveFirstUrl(item.images) ||
        resolveFirstUrl(item.image_urls) ||
        resolveFirstUrl(item.cover) ||
        resolveFirstUrl(item.cover_url) ||
        resolveFirstUrl(noteCard.image_list) ||
        resolveFirstUrl(noteCard.images) ||
        resolveFirstUrl(noteCard.image_urls) ||
        resolveFirstUrl(noteCard.cover) ||
        resolveFirstUrl(noteCard.cover_url);
      const normalizedCover = normalizeXhsCoverUrl(
        cover ||
        noteCard.video?.cover?.url_list?.[0] ||
        noteCard.video?.cover?.url_default
      );
      const mediaUrl =
        item.video_url ||
        noteCard.video?.media?.stream?.h264?.[0]?.master_url ||
        normalizedCover;
      return {
        id: noteId,
        platform,
        externalId: noteId,
        title:
          item.title ||
          item.note_title ||
          noteCard.display_title ||
          item.desc?.slice(0, 40) ||
          noteCard.desc ||
          "",
        desc: item.desc || noteCard.desc,
        coverUrl: normalizedCover || item.video_cover || item.avatar,
        contentUrl: mediaUrl,
        authorName:
          item.nickname ||
          item.author?.nickname ||
          item.user?.nickname ||
          noteCard.user?.nickname ||
          noteCard.user?.nick_name ||
          "未知",
        authorAvatar: item.avatar || item.user?.avatar || noteCard.user?.avatar,
        authorUserId: item.user_id || item.user?.user_id || noteCard.user?.user_id || "",
        createdAt: toIsoDate(item.last_update_time || item.time || noteCard.last_update_time),
        likedCount: safeInt(item.liked_count ?? interactInfo.liked_count),
        collectedCount: safeInt(item.collected_count ?? interactInfo.collected_count),
        commentCount: safeInt(item.comment_count ?? interactInfo.comment_count),
        shareCount: safeInt(
          item.share_count ??
          item.shared_count ??
          interactInfo.share_count ??
          interactInfo.shared_count
        ),
        followerCount: safeInt(
          item.fans_count ||
          item.follower_count ||
          item.author?.fans_count ||
          item.user?.fans_count ||
          noteCard.user?.fans ||
          noteCard.user?.follower_count
        ),
      };
    }
    if (platform === "bili" || platform === "bilibili") {
      return {
        id: item.bvid || item.id || String(index),
        platform: "bili",
        externalId: item.bvid,
        title: item.title,
        desc: item.desc,
        coverUrl: item.pic,
        contentUrl: `https://www.bilibili.com/video/${item.bvid}`,
        authorName: item.owner?.name,
        authorUserId: item.owner?.mid ? String(item.owner.mid) : "",
        createdAt: toIsoDate(item.pubdate),
        likedCount: safeInt(item.liked_count || item.stat?.like),
        collectedCount: safeInt(item.collected_count || item.stat?.favorite),
        commentCount: safeInt(item.comment_count || item.stat?.reply),
        shareCount: safeInt(item.share_count || item.stat?.share),
      };
    }
    if (platform === "dy" || platform === "douyin") {
      return {
        id: item.aweme_id || String(index),
        platform: "dy",
        externalId: item.aweme_id,
        title: item.desc || "",
        desc: item.desc,
        coverUrl: item.video?.cover?.url_list?.[0],
        contentUrl: `https://www.douyin.com/video/${item.aweme_id}`,
        authorName: item.author?.nickname,
        authorUserId: item.author?.uid || item.author?.sec_uid || "",
        createdAt: toIsoDate(item.create_time),
        likedCount: safeInt(item.liked_count),
        collectedCount: safeInt(item.collected_count),
        commentCount: safeInt(item.comment_count),
        shareCount: safeInt(item.share_count),
      };
    }
    return {
      id: item.id || String(index),
      platform,
      externalId: item.id || String(index),
      title: item.title || "",
      desc: item.desc,
      coverUrl: item.coverUrl || item.cover,
      contentUrl: item.contentUrl || item.url,
      authorName: item.authorName || item.author || "未知",
      authorUserId: "",
      createdAt: toIsoDate(item.createdAt),
      likedCount: safeInt(item.liked_count),
      collectedCount: safeInt(item.collected_count),
      commentCount: safeInt(item.comment_count),
      shareCount: safeInt(item.share_count),
    };
  });
};

const getMaterialMergeKey = (item: MaterialItem) =>
  `${item.platform || "unknown"}:${item.externalId || item.id}`;

const mergeMaterialItems = (previous: MaterialItem[], incoming: MaterialItem[]) => {
  if (!previous.length) {
    return incoming;
  }
  if (!incoming.length) {
    return previous;
  }

  const merged = [...previous];
  const indexByKey = new Map<string, number>();
  merged.forEach((item, index) => {
    indexByKey.set(getMaterialMergeKey(item), index);
  });

  incoming.forEach((item) => {
    const key = getMaterialMergeKey(item);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, merged.length);
      merged.push(item);
      return;
    }
    merged[existingIndex] = {
      ...merged[existingIndex],
      ...item,
    };
  });

  return merged;
};

// ────────────────── Login Status Type ──────────────────

interface LoginStatus {
  checking: boolean;
  hasValidLogin: boolean;
  message: string;
  cookiesFound?: string[];
}

// ────────────────── Main Component ──────────────────

export const MaterialsComponent = () => {
  const fetch = useFetch();
  const router = useRouter();
  const { backendUrl } = useVariables();

  // Search state
  const [loading, setLoading] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [statusMessage, setStatusMessage] = useState("");
  const [rawResults, setRawResults] = useState<MaterialItem[]>([]);
  const [enriching, setEnriching] = useState(false);
  const [loginStarting, setLoginStarting] = useState(false);
  const [loginPhone, setLoginPhone] = useState("");
  const [smsCode, setSmsCode] = useState("");
  const [smsSubmitting, setSmsSubmitting] = useState(false);
  const [smsVerifying, setSmsVerifying] = useState(false);
  const [phoneLoginJobId, setPhoneLoginJobId] = useState<string | null>(null);
  const [smsRequested, setSmsRequested] = useState(false);
  const [smsCooldownSeconds, setSmsCooldownSeconds] = useState(0);
  const [showLoginDialog, setShowLoginDialog] = useState(false);
  const [loginAgreementAccepted, setLoginAgreementAccepted] = useState(false);
  const [loginQrCodeBase64, setLoginQrCodeBase64] = useState("");

  // Login state
  const [loginStatus, setLoginStatus] = useState<LoginStatus>({
    checking: true,
    hasValidLogin: false,
    message: "正在检测登录状态...",
  });

  // Viral settings
  const [viralThresholds, setViralThresholds] = useState<ViralThresholds>(
    DEFAULT_VIRAL_THRESHOLDS
  );
  const [onlyShowViral, setOnlyShowViral] = useState(false);

  // Refs
  const eventSourceRef = useRef<EventSource | null>(null);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);
  const loginPollingRef = useRef<NodeJS.Timeout | null>(null);
  const currentPlatformRef = useRef<string>("xhs");
  const smsVerifyingRef = useRef(false);
  const requestedLoginTypeRef = useRef<"qrcode" | "phone" | null>(null);
  const autoLoginPromptedRef = useRef(false);
  const phoneCodeSubmittedRef = useRef(false);
  const loginInvalidStreakRef = useRef(0);
  const loginStatusRef = useRef<LoginStatus>({
    checking: true,
    hasValidLogin: false,
    message: "checking login status...",
  });
  const restoredResultsRef = useRef(false);
  const warmedMediaUrlsRef = useRef<Set<string>>(new Set());

  // ────────── Viral Filtering & Scoring ──────────

  const scoredResults = useMemo(
    () =>
      rawResults.map((item) => {
        const viralResult = calculateViralScore(
          {
            likes: item.likedCount || 0,
            shares: item.shareCount || 0,
            comments: item.commentCount || 0,
            collects: item.collectedCount || 0,
            followers: item.followerCount || 0,
            publishedAt: item.createdAt,
          },
          viralThresholds
        );
        return { ...item, viralResult };
      }),
    [rawResults, viralThresholds]
  );

  const processedResults = useMemo(() => {
    if (!onlyShowViral) {
      return scoredResults;
    }
    return scoredResults.filter((item) => item.viralResult?.isViral);
  }, [onlyShowViral, scoredResults]);

  // ────────── Stats ──────────

  const viralCount = useMemo(
    () => scoredResults.filter((item) => item.viralResult?.isViral).length,
    [scoredResults]
  );

  const enrichedCount = useMemo(
    () => rawResults.filter(i => (i.followerCount || 0) > 0).length,
    [rawResults]
  );

  useEffect(() => {
    if (!scoredResults.length) {
      return;
    }
    persistMaterialDataset(scoredResults);
  }, [scoredResults]);

  useEffect(() => {
    if (restoredResultsRef.current) {
      return;
    }
    restoredResultsRef.current = true;
    const restored = loadLastMaterialResults();
    if (!restored.length) {
      return;
    }
    setRawResults(restored);
    setStatusMessage("已恢复上次关键词搜索结果");
  }, []);

  useEffect(() => {
    if (!rawResults.length) {
      return;
    }
    persistLastMaterialResults(rawResults);
  }, [rawResults]);

  useEffect(() => {
    const candidates = scoredResults
      .filter((item) => isLikelyVideoUrl(item.contentUrl))
      .sort((a, b) => (b.viralResult?.score || 0) - (a.viralResult?.score || 0))
      .slice(0, 8)
      .map((item) => getProxiedUrl(item.contentUrl, item.platform, backendUrl))
      .filter(Boolean);

    if (!candidates.length) {
      return;
    }

    let disposed = false;
    void (async () => {
      for (const url of candidates) {
        if (disposed) {
          return;
        }
        if (warmedMediaUrlsRef.current.has(url)) {
          continue;
        }
        warmedMediaUrlsRef.current.add(url);
        await warmMediaCache(url);
      }
    })();

    return () => {
      disposed = true;
    };
  }, [backendUrl, scoredResults]);

  const handleOpenAnalysis = useCallback(
    (item: MaterialItem) => {
      const mediaUrl = isLikelyVideoUrl(item.contentUrl)
        ? item.contentUrl
        : item.coverUrl;
      const warmupUrl = getProxiedUrl(mediaUrl, item.platform, backendUrl);
      if (warmupUrl && !warmedMediaUrlsRef.current.has(warmupUrl)) {
        warmedMediaUrlsRef.current.add(warmupUrl);
        void warmMediaCache(warmupUrl);
      }
      const storageKey = getMaterialStorageKey(item);
      router.push(`/materials/analysis/${encodeURIComponent(storageKey)}`);
    },
    [backendUrl, router]
  );

  // ────────── Cleanup ──────────

  const closeEventSource = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  };

  const stopPolling = () => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  };

  const stopLoginPolling = () => {
    if (loginPollingRef.current) {
      clearInterval(loginPollingRef.current);
      loginPollingRef.current = null;
    }
  };

  const closeLoginDialog = () => setShowLoginDialog(false);

  useEffect(() => {
    return () => {
      closeEventSource();
      stopPolling();
      stopLoginPolling();
    };
  }, []);

  useEffect(() => {
    if (smsCooldownSeconds <= 0) {
      return;
    }
    const timer = setInterval(() => {
      setSmsCooldownSeconds((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [smsCooldownSeconds]);

  useEffect(() => {
    smsVerifyingRef.current = smsVerifying;
  }, [smsVerifying]);

  useEffect(() => {
    loginStatusRef.current = loginStatus;
  }, [loginStatus]);

  // ────────── Login Status Check ──────────

  const refreshLoginStatus = useCallback(async (platform = "xhs") => {
    try {
      const resp = await fetch(`/materials/login-status?platform=${platform}`);
      if (!resp.ok) {
        if (resp.status === 401 || resp.status === 403) {
          setLoginStatus({
            checking: false,
            hasValidLogin: false,
            message: "not logged in",
          });
          return false;
        }
        throw new Error(`HTTP ${resp.status}`);
      }
      const data = await resp.json();
      setLoginStatus({
        checking: false,
        hasValidLogin: data.has_valid_login ?? false,
        message: data.message || (data.has_valid_login ? "已登录" : "未登录"),
        cookiesFound: data.cookies_found,
      });
      return data.has_valid_login;
    } catch {
      const previous = loginStatusRef.current;
      if (previous?.hasValidLogin) {
        setLoginStatus({
          ...previous,
          checking: false,
          hasValidLogin: true,
        });
        return true;
      }
      setLoginStatus({
        checking: false,
        hasValidLogin: false,
        message: "无法检测登录状态",
      });
      return false;
    }
  }, [fetch]);

  const completeLoginSuccess = useCallback(
    async (platform = "xhs") => {
      // Optimistically update UI immediately to avoid "success but still stuck in modal".
      closeLoginDialog();
      setSmsRequested(false);
      setPhoneLoginJobId(null);
      setSmsVerifying(false);
      setLoginStarting(false);
      phoneCodeSubmittedRef.current = false;
      loginInvalidStreakRef.current = 0;
      setLoginStatus((prev) => ({
        ...prev,
        checking: true,
        hasValidLogin: true,
        message: "已登录",
      }));
      autoLoginPromptedRef.current = false;
      setStatusMessage("登录成功，正在保存并校验Cookie...");
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const hasLogin = await refreshLoginStatus(platform);
        if (hasLogin) {
          setLoginStatus((prev) => ({
            ...prev,
            checking: false,
            hasValidLogin: true,
            message: "已登录",
          }));
          autoLoginPromptedRef.current = false;
          setStatusMessage("登录成功，Cookie已保存，下次将自动免登录");
          return true;
        }
        await sleep(1000);
      }

      setLoginStatus((prev) => ({
        ...prev,
        checking: false,
        hasValidLogin: false,
        message: "未登录",
      }));
      autoLoginPromptedRef.current = true;
      setShowLoginDialog(true);
      setStatusMessage("登录状态未生效，请重新进行手机号登录");
      return false;
    },
    [refreshLoginStatus]
  );

  const markLoginRequired = useCallback(
    (message = "Login required. Please click login to continue.", autoOpen = true) => {
      loginInvalidStreakRef.current = Math.max(loginInvalidStreakRef.current, 2);
      setLoginStatus((prev) => ({
        ...prev,
        checking: false,
        hasValidLogin: false,
        message,
      }));
      autoLoginPromptedRef.current = true;
      if (autoOpen) {
        setShowLoginDialog(true);
      }
    },
    []
  );

  const guardPhoneLoginSuccess = () => {
    if (requestedLoginTypeRef.current !== "phone") {
      return true;
    }
    if (phoneCodeSubmittedRef.current) {
      return true;
    }
    stopLoginPolling();
    closeEventSource();
    setLoading(false);
    setLoginStarting(false);
    setSmsVerifying(false);
    setSmsRequested(false);
    setPhoneLoginJobId(null);
    requestedLoginTypeRef.current = null;
    setShowLoginDialog(true);
    setStatusMessage("请先输入验证码并提交，再完成登录。请重新获取验证码。");
    return false;
  };

  useEffect(() => {
    let disposed = false;
    const bootstrapLoginState = async () => {
      setLoginStatus((prev) => ({
        ...prev,
        checking: true,
        message: "正在检测登录状态...",
      }));
      const hasLogin = await refreshLoginStatus("xhs");
      if (disposed) {
        return;
      }
      if (hasLogin) {
        loginInvalidStreakRef.current = 0;
        autoLoginPromptedRef.current = false;
        // Keep dialog open if user is in the middle of phone login flow.
        if (
          requestedLoginTypeRef.current !== "phone" &&
          !smsRequested &&
          !smsVerifyingRef.current
        ) {
          setShowLoginDialog(false);
        }
        return;
      }
      if (!loginStarting && !smsVerifyingRef.current) {
        autoLoginPromptedRef.current = true;
        setShowLoginDialog(true);
        setStatusMessage("检测到Cookie无效，请使用手机号验证码重新登录");
      }
    };
    void bootstrapLoginState();
    return () => {
      disposed = true;
    };
  }, [refreshLoginStatus, smsRequested]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (loading || loginStarting || smsVerifyingRef.current) {
        return;
      }
      void (async () => {
        const hasLogin = await refreshLoginStatus(currentPlatformRef.current);
        if (hasLogin) {
          loginInvalidStreakRef.current = 0;
          autoLoginPromptedRef.current = false;
          return;
        }
        loginInvalidStreakRef.current += 1;
        if (loginInvalidStreakRef.current < 2) {
          return;
        }
        if (!showLoginDialog && !autoLoginPromptedRef.current) {
          autoLoginPromptedRef.current = true;
          setShowLoginDialog(true);
          setStatusMessage("登录状态已失效，请重新进行手机号登录");
        }
      })();
    }, 30000);
    return () => clearInterval(timer);
  }, [refreshLoginStatus, loading, loginStarting, showLoginDialog]);

  // ────────── Enrich with Follower Data ──────────

  const enrichWithFollowerData = useCallback(async (items: MaterialItem[], platform: string) => {
    // Get unique user IDs that don't already have follower data
    const userIdsToFetch = [...new Set(
      items
        .filter(item => item.authorUserId && (item.followerCount || 0) === 0)
        .map(item => item.authorUserId!)
    )];

    if (userIdsToFetch.length === 0) return items;

    setEnriching(true);
    setStatusMessage(`正在获取 ${userIdsToFetch.length} 位作者的粉丝数据...`);

    try {
      const resp = await fetch("/materials/enrich-profiles", {
        method: "POST",
        body: JSON.stringify({
          platform,
          user_ids: userIdsToFetch,
        }),
      });
      const data = await resp.json();

      if (data.profiles && data.profiles.length > 0) {
        // Build a map of user_id -> fans count
        const fansMap = new Map<string, number>();
        for (const profile of data.profiles) {
          if (profile.fans !== undefined && profile.fans !== null && !profile.error) {
            fansMap.set(profile.user_id, profile.fans);
          }
        }

        // Merge into results
        const enriched = items.map(item => {
          if (item.authorUserId && fansMap.has(item.authorUserId)) {
            return { ...item, followerCount: fansMap.get(item.authorUserId)! };
          }
          return item;
        });

        setStatusMessage(`粉丝数据已获取 (${data.fetched}/${userIdsToFetch.length} 成功)`);
        setEnriching(false);
        return enriched;
      }
    } catch (error) {
      console.error("Failed to enrich profiles:", error);
      setStatusMessage("粉丝数据获取失败，使用基础评分");
    }

    setEnriching(false);
    return items;
  }, [fetch]);

  const mapResultsPayloadToItems = useCallback((resultsData: any, platform: string) => {
    const fullItems = extractResultsItems(resultsData?.data);
    if (fullItems.length > 0) {
      return mapToMaterialItems(fullItems, platform);
    }
    if (resultsData?.preview) {
      return mapToMaterialItems(resultsData.preview, platform);
    }
    return [] as MaterialItem[];
  }, []);

  const refreshJobResults = useCallback(
    async (
      currentJobId: string,
      platform: string,
      withEnrichment = false
    ) => {
      const resultsResp = await fetch(`/materials/results?jobId=${currentJobId}`);
      if (!resultsResp.ok) {
        return null;
      }
      const resultsData = await resultsResp.json();
      const mapped = mapResultsPayloadToItems(resultsData, platform);
      if (mapped.length === 0) {
        return resultsData;
      }
      if (withEnrichment) {
        const enrichedItems = await enrichWithFollowerData(mapped, platform);
        setRawResults((previous) => mergeMaterialItems(previous, enrichedItems));
      } else {
        setRawResults((previous) => mergeMaterialItems(previous, mapped));
      }
      return resultsData;
    },
    [fetch, mapResultsPayloadToItems, enrichWithFollowerData]
  );

  // ────────── Polling ──────────

  const pollJobStatus = useCallback(
    async (currentJobId: string) => {
      try {
        const resp = await fetch(`/materials/job-status?jobId=${currentJobId}`);
        const status = await resp.json();

        if (status.state === "succeeded") {
          setProgress(100);
          setStatusMessage("搜索完成！正在获取作者粉丝数据...");
          stopPolling();
          await refreshJobResults(currentJobId, currentPlatformRef.current, true);
          setLoading(false);
          setJobId(null);
          closeLoginDialog();
          setLoginStatus((prev) => ({
            ...prev,
            hasValidLogin: true,
            message: "已登录",
          }));
        } else if (status.state === "failed") {
          const failureMessage = String(status.error || status.message || "unknown error");
          setProgress(0);
          setStatusMessage(`Search failed: ${status.error || "unknown error"}`);
          stopPolling();
          setLoading(false);
          setJobId(null);
          if (failureMessage.toLowerCase().includes("login required")) {
            markLoginRequired();
          }
        } else if (status.state === "running" || status.state === "active") {
          setProgress(status.progress ? status.progress * 100 : 50);
          setStatusMessage(status.message || "正在搜索中...");
          await refreshJobResults(currentJobId, currentPlatformRef.current, false);
        } else if (status.state === "queued" || status.state === "waiting") {
          setProgress(10);
          setStatusMessage("排队中，等待开始...");
          await refreshJobResults(currentJobId, currentPlatformRef.current, false);
        }
      } catch (error) {
        console.error("Polling error:", error);
      }
    },
    [fetch, refreshJobResults, markLoginRequired]
  );

  // ────────── Search Handler ──────────

  const handleSearch = async (params: {
    platform: string;
    keywords: string;
    limit: number;
    incremental: boolean;
  }) => {
    const normalizedKeywords = params.keywords.trim();
    if (!normalizedKeywords) {
      setLoading(false);
      setStatusMessage("请输入关键词");
      return;
    }

    setLoading(true);
    setRawResults([]);
    setJobId(null);
    setProgress(0);
    setStatusMessage("正在启动搜索...");
    setSmsRequested(false);
    setPhoneLoginJobId(null);
    closeLoginDialog();
    closeEventSource();
    stopPolling();
    currentPlatformRef.current = params.platform;

    try {
      const resp = await fetch("/materials/search", {
        method: "POST",
        body: JSON.stringify({
          platform: params.platform,
          keywords: normalizedKeywords,
          pageLimit: params.limit,
          forceCrawl: params.incremental,
          incremental: params.incremental,
        }),
      });
      const data = await resp.json();

      if (data.cacheHit && data.cachedResults && !data.jobId) {
        const cachedItems = extractResultsItems(data.cachedResults);
        let items = mapToMaterialItems(
          cachedItems.length > 0 ? cachedItems : data.preview || [],
          params.platform
        );
        // Enrich cached results too
        items = await enrichWithFollowerData(items, params.platform);
        setRawResults(items);
        setLoading(false);
        setStatusMessage("从缓存加载");
        return;
      }

      if (data.historyResults) {
        const historyItems = mapResultsPayloadToItems(data.historyResults, params.platform);
        if (historyItems.length > 0) {
          setRawResults(historyItems);
          if (params.incremental) {
            setStatusMessage(
              `已加载历史 ${data.historyCount || historyItems.length} 条，正在增量抓取...`
            );
          } else {
            setStatusMessage(`已加载历史 ${data.historyCount || historyItems.length} 条`);
          }
        }
      }

      if (data.jobId) {
        setJobId(data.jobId);
        if (!data.historyResults) {
          setStatusMessage(`任务已创建: ${data.state}`);
        }
        setProgress(10);

        pollingRef.current = setInterval(() => {
          pollJobStatus(data.jobId);
        }, 3000);
        pollJobStatus(data.jobId);
        startSSE(data.jobId, params.platform);
      } else {
        setJobId(null);
        if (params.incremental) {
          setLoading(false);
          setStatusMessage("未创建增量任务");
        } else if (!data.historyResults) {
          setLoading(false);
          setStatusMessage("未找到历史结果");
        } else {
          setLoading(false);
        }
      }
    } catch (error) {
      console.error(error);
      setLoading(false);
      setStatusMessage("搜索启动失败");
    }
  };

  const handleStopSearch = useCallback(async () => {
    if (!jobId) {
      return;
    }
    try {
      await fetch("/materials/stop", {
        method: "POST",
        body: JSON.stringify({ jobId }),
      });
      setStatusMessage("已停止爬取");
    } catch (error) {
      setStatusMessage("停止请求失败，请重试");
    } finally {
      closeEventSource();
      stopPolling();
      setLoading(false);
      setProgress(0);
      setJobId(null);
    }
  }, [fetch, jobId, closeEventSource, stopPolling]);

  // ────────── Trigger Login Handler ──────────

  const startLoginFlow = async (loginType: "qrcode" | "phone") => {
    if (loading || loginStarting) return;
    const normalizedPhone = loginPhone.replace(/\D/g, "");
    if (loginType === "phone" && !normalizedPhone) {
      setStatusMessage("请输入手机号");
      return;
    }
    if (loginType === "qrcode") {
      setSmsRequested(false);
      setPhoneLoginJobId(null);
      setSmsVerifying(false);
      setLoginQrCodeBase64("");
      setShowLoginDialog(true);
    }

    setLoginStarting(true);
    setStatusMessage(
      loginType === "phone" ? "正在获取验证码..." : "正在获取登录二维码..."
    );
    setProgress(0);
    requestedLoginTypeRef.current = loginType;
    if (loginType === "phone") {
      phoneCodeSubmittedRef.current = false;
    }
    closeEventSource();
    stopPolling();
    stopLoginPolling();

    try {
      const resp = await fetch("/materials/trigger-login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          platform: currentPlatformRef.current,
          loginType,
          loginPhone: loginType === "phone" ? normalizedPhone : undefined,
        }),
      });
      const text = await resp.text();
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${text}`);
      }
      const data = text ? JSON.parse(text) : {};
      if (loginType === "phone" && data?.loginType && data.loginType !== "phone") {
        throw new Error(
          `loginType mismatch: requested phone but server accepted ${data.loginType}`
        );
      }

      if (data.jobId) {
        setJobId(data.jobId);
        if (loginType === "phone") {
          setPhoneLoginJobId(data.jobId);
          setSmsRequested(true);
          setSmsVerifying(false);
          setSmsCooldownSeconds(180);
          setLoginStarting(false);
          setStatusMessage("验证码已发送，请输入验证码后点击登录");
        } else {
          setStatusMessage("登录任务已创建，等待二维码...");
        }
        startSSE(data.jobId, currentPlatformRef.current, loginType);
        let attempts = 0;
        loginPollingRef.current = setInterval(async () => {
          attempts += 1;
          try {
            const statusResp = await fetch(`/materials/job-status?jobId=${data.jobId}`);
            if (!statusResp.ok) {
              return;
            }
            const status = await statusResp.json();
            if (loginType === "phone" && smsVerifyingRef.current) {
              const hasLogin = await refreshLoginStatus(currentPlatformRef.current);
              if (hasLogin) {
                stopLoginPolling();
                closeEventSource();
                await completeLoginSuccess(currentPlatformRef.current);
                return;
              }
            }
            if (status.state === "failed") {
              stopLoginPolling();
              closeEventSource();
              setLoginStarting(false);
              setSmsVerifying(false);
              phoneCodeSubmittedRef.current = false;
              if (loginType === "phone") {
                setSmsRequested(false);
                setPhoneLoginJobId(null);
              }
              setStatusMessage(
                `登录失败: ${status.error || status.message || "请确认 MediaCrawler 服务已启动 (8081)"}`
              );
              return;
            }
            if (status.state === "succeeded") {
              stopLoginPolling();
              if (!guardPhoneLoginSuccess()) {
                return;
              }
              setLoginStarting(false);
              setSmsVerifying(false);
              phoneCodeSubmittedRef.current = false;
              if (loginType === "phone") {
                setSmsRequested(false);
                setPhoneLoginJobId(null);
              }
              await completeLoginSuccess(currentPlatformRef.current);
            }

            if (loginType === "qrcode") {
              const qrResp = await fetch(`/materials/login-qrcode?jobId=${data.jobId}`);
              if (qrResp.ok) {
                const qrData = await qrResp.json();
                if (qrData?.base64_image) {
                  const normalized = normalizeQrBase64(qrData.base64_image);
                  if (normalized) {
                    setLoginQrCodeBase64(normalized);
                    setShowLoginDialog(true);
                  }
                }
              }
            }
          } catch {
            // Ignore transient polling errors and keep waiting.
          }
          if (attempts >= 90) {
            stopLoginPolling();
            closeEventSource();
            setLoginStarting(false);
            setSmsVerifying(false);
            phoneCodeSubmittedRef.current = false;
            if (loginType === "phone") {
              setSmsRequested(false);
              setPhoneLoginJobId(null);
            }
            setStatusMessage(
              loginType === "phone"
                ? "手机号登录等待超时，请重试"
                : "等待二维码超时，请确认 MediaCrawler 服务已启动 (8081)"
            );
          }
        }, 2000);
      } else {
        setLoginStarting(false);
        setSmsVerifying(false);
        requestedLoginTypeRef.current = null;
        phoneCodeSubmittedRef.current = false;
        if (loginType === "phone") {
          setSmsRequested(false);
          setPhoneLoginJobId(null);
        }
        setStatusMessage(data?.message || "登录任务创建失败");
      }
    } catch (error) {
      console.error("Failed to trigger login:", error);
      setLoginStarting(false);
      setSmsVerifying(false);
      requestedLoginTypeRef.current = null;
      phoneCodeSubmittedRef.current = false;
      if (loginType === "phone") {
        setSmsRequested(false);
        setPhoneLoginJobId(null);
      }
      const message =
        error instanceof Error ? error.message : "触发登录失败，请检查后端与 MediaCrawler 服务";
      if (message.includes("loginType mismatch")) {
        setStatusMessage("服务端未进入手机号模式，请重试并确保点击“获取验证码”按钮");
      } else {
        setStatusMessage("触发登录失败，请检查后端与 MediaCrawler 服务");
      }
    }
  };

  const handleOpenLoginDialog = () => {
    setShowLoginDialog(true);
  };

  const handleTriggerLogin = async () => {
    setShowLoginDialog(true);
    await startLoginFlow("qrcode");
  };

  const handleRequestSmsCode = async () => {
    if (smsCooldownSeconds > 0) {
      return;
    }
    if (!loginAgreementAccepted) {
      setStatusMessage("请先勾选并同意用户协议");
      return;
    }
    setShowLoginDialog(true);
    await startLoginFlow("phone");
  };

  const handlePhoneLogin = async () => {
    const normalizedPhone = loginPhone.replace(/\D/g, "");
    const normalizedCode = smsCode.replace(/\D/g, "");
    if (!normalizedPhone) {
      setStatusMessage("请输入手机号");
      return;
    }
    if (!normalizedCode) {
      setStatusMessage("请输入验证码");
      return;
    }
    if (!loginAgreementAccepted) {
      setStatusMessage("请先勾选并同意用户协议");
      return;
    }
    if (!smsRequested || !phoneLoginJobId) {
      setStatusMessage("请先点击获取验证码");
      return;
    }

    setSmsSubmitting(true);
    try {
      const resp = await fetch("/materials/submit-sms-code", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          platform: currentPlatformRef.current,
          loginPhone: normalizedPhone,
          smsCode: normalizedCode,
          jobId: phoneLoginJobId,
        }),
      });
      const text = await resp.text();
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${text}`);
      }
      setStatusMessage("验证码已提交，正在验证登录...");
      setSmsCode("");
      setSmsVerifying(true);
      setLoginStarting(true);
      phoneCodeSubmittedRef.current = true;
    } catch (error) {
      console.error("Failed to submit sms code:", error);
      const message = error instanceof Error ? error.message : "";
      if (
        message.includes("当前登录任务不是手机号模式") ||
        message.includes("login job not found")
      ) {
        setStatusMessage("登录任务类型异常，请先点击“获取验证码”重新开始");
        setSmsRequested(false);
        setPhoneLoginJobId(null);
      } else {
        setStatusMessage("验证码提交失败，请重试");
      }
      setSmsVerifying(false);
      setLoginStarting(false);
      phoneCodeSubmittedRef.current = false;
    } finally {
      setSmsSubmitting(false);
    }
  };


  // ────────── SSE ──────────

  const startSSE = (id: string, platform: string, loginType: "qrcode" | "phone" = "qrcode") => {
    const sseUrl = `${backendUrl}/materials/events?jobId=${id}`;
    const isLoginFlow = id.startsWith("login_");
    try {
      const es = new EventSource(sseUrl, { withCredentials: true });
      eventSourceRef.current = es;

      const handlePayload = async (payload: any, eventType?: string) => {
        const type = eventType || payload.type;
        switch (type) {
          case "status":
            if (!isLoginFlow && payload.state === "login_required") {
              markLoginRequired(payload.message || "Login required. Please click login to continue.");
              setLoading(false);
            }
            if (payload.state === "running") {
              setProgress(payload.progress ? payload.progress * 100 : 50);
              if (!isLoginFlow) {
                try {
                  await refreshJobResults(id, platform, false);
                } catch {
                  // Ignore transient incremental refresh errors.
                }
              }
            } else if (payload.state === "succeeded") {
              setProgress(100);
            } else {
              setProgress(payload.progress ? payload.progress * 100 : 0);
            }
            setStatusMessage(payload.message || payload.state);
            if (
              payload.state === "succeeded" ||
              payload.state === "failed"
            ) {
              setLoading(false);
              if (!isLoginFlow) {
                setJobId(null);
              }
              stopLoginPolling();
              if (
                isLoginFlow &&
                payload.state === "succeeded" &&
                !guardPhoneLoginSuccess()
              ) {
                break;
              }
              setLoginStarting(false);
              setSmsVerifying(false);
              phoneCodeSubmittedRef.current = false;
              if (isLoginFlow) {
                setSmsRequested(false);
                setPhoneLoginJobId(null);
              }
              if (payload.state === "succeeded") {
                closeEventSource();
                if (isLoginFlow) {
                  await completeLoginSuccess(platform);
                } else {
                  await refreshJobResults(id, platform, true);
                  stopPolling();
                }
              }
            }
            break;
          case "log":
            if (typeof payload.message === "string") {
              const msg = payload.message as string;
              if (
                requestedLoginTypeRef.current === "phone" &&
                msg.includes("Starting crawler:") &&
                msg.includes("--lt qrcode")
              ) {
                setStatusMessage("后端实际进入了二维码模式，请点击“获取验证码”重试");
                setLoginStarting(false);
                setSmsVerifying(false);
                setSmsRequested(false);
                setPhoneLoginJobId(null);
                phoneCodeSubmittedRef.current = false;
                requestedLoginTypeRef.current = null;
                stopLoginPolling();
                break;
              }
              if (
                isLoginFlow &&
                (msg.includes("登录成功") ||
                  msg.includes("Login successful") ||
                  /login .*successful/i.test(msg))
              ) {
                if (!guardPhoneLoginSuccess()) {
                  break;
                }
                requestedLoginTypeRef.current = null;
                setLoginStarting(false);
                setSmsVerifying(false);
                phoneCodeSubmittedRef.current = false;
                stopLoginPolling();
                await completeLoginSuccess(platform);
                break;
              }
              if (
                msg.includes("SMS send may be blocked by captcha/verification")
              ) {
                setStatusMessage("验证码发送可能被小红书安全验证拦截，请在弹窗中完成验证后重试");
              } else if (
                msg.includes("phone_login_blocked:sms_send_no_effect")
              ) {
                setStatusMessage("点击获取验证码后未触发发送，请确认手机号和协议勾选后重试");
              } else if (
                msg.includes("phone_login_blocked:invalid_sms_code") ||
                msg.includes("phone_login_blocked:expired_sms_code")
              ) {
                setStatusMessage("验证码错误或已失效，请重新获取验证码");
              } else if (
                msg.includes("phone_login_blocked:captcha/verification")
              ) {
                setStatusMessage("登录被小红书安全验证拦截，请在页面完成验证后重试");
              } else if (
                msg.includes("phone_login_blocked:agreement_not_checked")
              ) {
                setStatusMessage("请先勾选登录协议后再获取验证码");
              } else if (
                msg.includes("phone_login_blocked:rate_limited")
              ) {
                setStatusMessage("验证码请求过于频繁，请稍后再试");
              } else if (
                msg.includes("phone_login_blocked:ip_restricted")
              ) {
                setStatusMessage("当前网络触发小红书风控，验证码可能无法下发，请切换网络后重试");
              } else if (
                msg.includes("phone_login_blocked:submit_no_effect")
              ) {
                setStatusMessage("验证码已提交但未触发登录，请确认弹窗内已完成协议确认后重试");
              } else if (
                msg.includes("agreement_dialog_stuck")
              ) {
                setStatusMessage("小红书协议弹窗未自动处理，请重试登录");
              } else if (
                msg.includes("XHS access restricted") ||
                msg.includes("IP存在风险") ||
                msg.includes("安全限制")
              ) {
                setStatusMessage("当前网络触发小红书风控，验证码可能无法下发，请切换网络后重试");
              }
            }
            break;
          case "result":
            try {
              await refreshJobResults(id, platform, false);
            } catch (err) {
              if (payload.preview) {
                setRawResults((previous) =>
                  mergeMaterialItems(
                    previous,
                    mapToMaterialItems(payload.preview, platform)
                  )
                );
              }
            }
            break;
          case "error":
            setStatusMessage(`错误: ${payload.message}`);
            if (!isLoginFlow && String(payload.message || "").toLowerCase().includes("login required")) {
              markLoginRequired("Login required. Please click login to continue.");
            }
            setLoading(false);
            setJobId(null);
            setLoginStarting(false);
            setSmsVerifying(false);
            phoneCodeSubmittedRef.current = false;
            setSmsRequested(false);
            setPhoneLoginJobId(null);
            closeEventSource();
            stopPolling();
            stopLoginPolling();
            break;
          case "login_qrcode":
            if (!isLoginFlow) {
              break;
            }
            if (payload.base64_image) {
              const normalized = normalizeQrBase64(payload.base64_image);
              if (normalized) {
                setLoginQrCodeBase64(normalized);
                setShowLoginDialog(true);
              }
            }
            break;
          case "sms_required":
            if (!isLoginFlow) {
              break;
            }
            setLoginStarting(false);
            setSmsRequested(true);
            setPhoneLoginJobId(id);
            setStatusMessage(payload.message || "请输入短信验证码");
            break;
          case "login_success":
            if (!isLoginFlow) {
              break;
            }
            if (!guardPhoneLoginSuccess()) {
              break;
            }
            setJobId(null);
            setSmsRequested(false);
            setPhoneLoginJobId(null);
            setSmsVerifying(false);
            phoneCodeSubmittedRef.current = false;
            requestedLoginTypeRef.current = null;
            closeEventSource();
            stopPolling();
            stopLoginPolling();
            setLoading(false);
            setLoginStarting(false);
            await completeLoginSuccess(platform);
            break;
        }
      };

      es.onmessage = async (event) => {
        try {
          const payload = JSON.parse(event.data);
          await handlePayload(payload, event.type);
        } catch (e) {
          console.error("SSE Parse Error", e);
        }
      };

      ["status", "log", "result", "error", "login_qrcode", "sms_required", "login_success"].forEach(
        (type) => {
          es.addEventListener(type, async (event) => {
            try {
              const payload = JSON.parse((event as MessageEvent).data);
              await handlePayload(payload, type);
            } catch (e) {
              console.error("SSE Parse Error", e);
            }
          });
        }
      );

      es.onerror = () => {
        if (isLoginFlow) {
          setStatusMessage((prev) => {
            const hasSpecificReason =
              typeof prev === "string" &&
              [
                "登录失败",
                "请先勾选",
                "验证码",
                "风控",
                "拦截",
                "超时",
              ].some((token) => prev.includes(token));
            if (hasSpecificReason) {
              return prev;
            }
            return loginType === "phone"
              ? "实时连接异常，正在轮询登录状态..."
              : "实时连接异常，正在轮询任务状态...";
          });
        }
      };
    } catch (error) {
      console.error("Failed to start SSE:", error);
    }
  };

  // ────────── Render ──────────

  return (
    <div className="flex flex-col gap-4 text-white">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">素材库</h1>
          <span className="text-xs text-gray-500">搜索爆款内容</span>
        </div>

        <div className="flex flex-col items-end gap-2">
          {/* Login Status Badge */}
          <div
            onClick={handleOpenLoginDialog}
            title={
              loginStatus.hasValidLogin
                ? "已登录（点击可重新登录）"
                : "未登录（点击登录）"
            }
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all group ${loginStarting
              ? "bg-yellow-500/10 text-yellow-300 cursor-wait"
              : loginStatus.checking
              ? "bg-gray-700 text-gray-400 cursor-wait"
              : loginStatus.hasValidLogin
                ? "bg-green-500/15 text-green-400 cursor-pointer hover:bg-green-500/20 active:scale-95"
                : "bg-red-500/10 text-red-400 cursor-pointer hover:bg-red-500/20 active:scale-95"
              }`}
          >
            <div
              className={`w-1.5 h-1.5 rounded-full ${loginStarting
                ? "bg-yellow-300 animate-pulse"
                : loginStatus.checking
                ? "bg-gray-400 animate-pulse"
                : loginStatus.hasValidLogin
                  ? "bg-green-400"
                  : "bg-red-400 group-hover:scale-125 transition-transform"
                }`}
            />
            {loginStarting
              ? "登录处理中..."
              : loginStatus.checking
              ? "检测中..."
              : loginStatus.hasValidLogin
              ? "已登录 (点此可重新登录)"
              : "未登录 (点此登录)"}
          </div>
        </div>
      </div>

      {showLoginDialog && (
        <div className="fixed inset-0 z-[320] flex items-center justify-center bg-black/55 p-4">
          <div className="w-full max-w-5xl overflow-hidden rounded-3xl bg-white text-[#222] shadow-2xl">
            <div className="flex items-center justify-end p-4">
              <button
                type="button"
                onClick={closeLoginDialog}
                className="rounded px-2 py-1 text-2xl leading-none text-gray-500 hover:bg-gray-100 hover:text-gray-800"
              >
                ×
              </button>
            </div>
            <div className="grid md:grid-cols-2">
              <div className="flex flex-col items-center bg-[#f7f7f9] px-6 py-8">
                <div className="mb-5 rounded-full bg-[#e7f1ff] px-6 py-3 text-center text-sm font-semibold text-[#3b82f6] md:text-xl">
                  登录后推荐更懂你的笔记
                </div>
                <div className="mb-4 rounded-full bg-[#ff274d] px-5 py-1.5 text-sm font-bold text-white md:text-lg">
                  小红书
                </div>
                <div className="flex min-h-[200px] min-w-[200px] items-center justify-center rounded-2xl bg-white p-3 shadow md:min-h-[250px] md:min-w-[250px]">
                  {loginQrCodeBase64 ? (
                    <img
                      src={`data:image/png;base64,${loginQrCodeBase64}`}
                      alt="登录二维码"
                      width={232}
                      height={232}
                      className="object-contain"
                    />
                  ) : (
                    <div className="text-sm text-gray-400">
                      {loginStarting ? "二维码加载中..." : "点击下方刷新二维码生成二维码"}
                    </div>
                  )}
                </div>
                <div className="mt-6 text-base text-[#111] md:text-2xl">
                  可用 <span className="font-semibold">小红书</span> 或 <span className="font-semibold">微信</span> 扫码
                </div>
                <button
                  type="button"
                  onClick={handleTriggerLogin}
                  disabled={loginStarting}
                  className="mt-6 h-10 rounded-full bg-[#ff274d] px-8 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {loginStarting ? "生成中..." : "刷新二维码"}
                </button>
              </div>

              <div className="flex flex-col px-8 pb-8">
                <div className="mb-7 mt-3 border-b border-[#efefef] pb-4">
                  <div className="text-sm font-medium text-[#111]">手机号登录</div>
                </div>

                <div className="flex flex-col gap-5">
                  <h3 className="text-2xl font-semibold text-[#222] md:text-3xl">手机号登录</h3>
                  <div className="flex h-12 items-center rounded-full bg-[#f5f5f7] px-5 md:h-14">
                    <span className="mr-4 border-r border-[#ddd] pr-4 text-[#333]">+86</span>
                    <input
                      className="h-full w-full bg-transparent text-base text-[#222] outline-none placeholder:text-[#b8b8b8] md:text-xl"
                      value={loginPhone}
                      onChange={(e) => {
                        setLoginPhone(e.target.value);
                        setSmsCode("");
                        setSmsRequested(false);
                        setPhoneLoginJobId(null);
                        setSmsVerifying(false);
                        setSmsCooldownSeconds(0);
                      }}
                      placeholder="输入手机号"
                    />
                  </div>
                  <div className="flex h-12 items-center rounded-full bg-[#f5f5f7] px-5 md:h-14">
                    <input
                      className="h-full flex-1 bg-transparent text-base text-[#222] outline-none placeholder:text-[#b8b8b8] md:text-xl"
                      value={smsCode}
                      onChange={(e) => setSmsCode(e.target.value)}
                      placeholder="验证码"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void handlePhoneLogin();
                        }
                      }}
                    />
                    <button
                      type="button"
                      onClick={handleRequestSmsCode}
                      disabled={(loginStarting && !smsRequested) || smsCooldownSeconds > 0}
                      className="text-sm font-medium text-[#ff6f87] disabled:cursor-not-allowed disabled:opacity-60 md:text-lg"
                    >
                      {smsCooldownSeconds > 0
                        ? `重新发送 (${smsCooldownSeconds}s)`
                        : loginStarting && !smsRequested
                        ? "发送中..."
                        : smsRequested
                        ? "重新发送"
                        : "获取验证码"}
                    </button>
                  </div>
                    <button
                      type="button"
                      onClick={handlePhoneLogin}
                      disabled={smsSubmitting || smsVerifying || !smsRequested || !smsCode.trim()}
                      className="mt-2 flex h-12 items-center justify-center gap-2 rounded-full bg-[#ff274d] text-lg font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60 md:h-14 md:text-2xl"
                    >
                      {(smsSubmitting || smsVerifying) && (
                        <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                      )}
                      {smsSubmitting
                        ? "提交中..."
                        : smsVerifying
                        ? "验证中..."
                        : "登录"}
                    </button>
                  <label className="mt-1 flex items-start gap-2 text-xs text-[#666] md:text-sm">
                    <input
                      type="checkbox"
                      checked={loginAgreementAccepted}
                      onChange={(e) => setLoginAgreementAccepted(e.target.checked)}
                      className="mt-1"
                    />
                    <span>
                      我已阅读并同意
                      <span className="text-[#2563eb]">《用户协议》</span>
                      <span className="text-[#2563eb]">《隐私政策》</span>
                      <span className="text-[#2563eb]">《儿童/青少年个人信息保护规则》</span>
                    </span>
                  </label>
                </div>
                <div className="mt-5 min-h-[24px] text-sm text-[#ff274d]">{statusMessage}</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Search Bar */}
      <MaterialsSearch
        onSearch={handleSearch}
        onStop={handleStopSearch}
        canStop={loading && !!jobId}
        isLoading={loading}
      />

      {/* Viral Settings */}
      <MaterialsViralSettings
        thresholds={viralThresholds}
        onChange={setViralThresholds}
        onlyShowViral={onlyShowViral}
        onToggleOnlyViral={setOnlyShowViral}
      />

      {/* Progress / Enriching Bar */}
      {(loading || enriching) && (
        <div className="bg-sixth border border-fifth rounded-lg p-3 flex flex-col gap-2">
          <div className="flex justify-between text-xs text-gray-400">
            <span>{statusMessage}</span>
            {loading && <span>{Math.round(progress)}%</span>}
          </div>
          <div className="w-full bg-gray-700 rounded-full h-1.5">
            <div
              className={`h-1.5 rounded-full transition-all duration-500 ${enriching ? "bg-blue-500 animate-pulse" : "bg-red-500"
                }`}
              style={{ width: enriching ? "100%" : `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Result Stats */}
      {rawResults.length > 0 && !loading && (
        <div className="flex items-center gap-4 text-xs text-gray-400 px-1">
          <span>
            共 <strong className="text-white">{rawResults.length}</strong> 条结果
          </span>
          <span>
            🔥 爆款 <strong className="text-red-400">{viralCount}</strong> 条
          </span>
          <span>
            👤 粉丝数据 <strong className="text-blue-400">{enrichedCount}</strong>/{rawResults.length}
          </span>
          {onlyShowViral && processedResults.length < rawResults.length && (
            <span className="text-yellow-400">
              已过滤，显示 {processedResults.length} 条
            </span>
          )}
        </div>
      )}

      {/* Results Grid */}
      <MaterialsResults items={processedResults} onItemClick={handleOpenAnalysis} />
    </div>
  );
};
