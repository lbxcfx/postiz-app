export interface Params {
  baseUrl: string;
  beforeRequest?: (url: string, options: RequestInit) => Promise<RequestInit>;
  afterRequest?: (
    url: string,
    options: RequestInit,
    response: Response
  ) => Promise<boolean>;
}

const isAbsoluteUrl = (value: string) => /^https?:\/\//i.test(value);

const normalizeBaseUrl = (value?: string | null) => (value || '').trim();

const resolveRequestUrl = (baseUrl: string, url: string) => {
  const normalizedUrl = (url || '').trim();
  if (!normalizedUrl) {
    throw new Error('customFetch received an empty URL');
  }

  if (isAbsoluteUrl(normalizedUrl)) {
    return normalizedUrl;
  }

  const normalizedPath = normalizedUrl.startsWith('/')
    ? normalizedUrl
    : `/${normalizedUrl}`;
  const normalizedBase = normalizeBaseUrl(baseUrl);

  if (normalizedBase) {
    try {
      return new URL(normalizedPath, normalizedBase).toString();
    } catch {
      // Fall through to env/window fallback.
    }
  }

  const fallbackBase =
    normalizeBaseUrl(process.env.NEXT_PUBLIC_BACKEND_URL) ||
    normalizeBaseUrl(process.env.BACKEND_INTERNAL_URL) ||
    normalizeBaseUrl(process.env.BACKEND_URL);

  if (fallbackBase) {
    return new URL(normalizedPath, fallbackBase).toString();
  }

  if (typeof window !== 'undefined') {
    return new URL(normalizedPath, window.location.origin).toString();
  }

  throw new Error(
    'customFetch cannot resolve base URL. Set NEXT_PUBLIC_BACKEND_URL/BACKEND_INTERNAL_URL.'
  );
};

export const customFetch = (
  params: Params,
  auth?: string,
  showorg?: string,
  secured: boolean = true
) => {
  return async function newFetch(url: string, options: RequestInit = {}) {
    const loggedAuth =
      typeof window === 'undefined'
        ? undefined
        : new URL(window.location.href).searchParams.get('loggedAuth');
    const newRequestObject = await params?.beforeRequest?.(url, options);
    const authNonSecuredCookie =
      typeof document === 'undefined'
        ? null
        : document.cookie
            .split(';')
            .find((p) => p.includes('auth='))
            ?.split('=')[1];

    const authNonSecuredOrg =
      typeof document === 'undefined'
        ? null
        : document.cookie
            .split(';')
            .find((p) => p.includes('showorg='))
            ?.split('=')[1];

    const authNonSecuredImpersonate =
      typeof document === 'undefined'
        ? null
        : document.cookie
            .split(';')
            .find((p) => p.includes('impersonate='))
            ?.split('=')[1];

    const fetchRequest = await fetch(resolveRequestUrl(params.baseUrl, url), {
      ...(secured ? { credentials: 'include' } : {}),
      ...(newRequestObject || options),
      headers: {
        ...(showorg
          ? { showorg }
          : authNonSecuredOrg
          ? { showorg: authNonSecuredOrg }
          : {}),
        ...(options.body instanceof FormData
          ? {}
          : { 'Content-Type': 'application/json' }),
        Accept: 'application/json',
        ...(loggedAuth ? { auth: loggedAuth } : {}),
        ...options?.headers,
        ...(auth
          ? { auth }
          : authNonSecuredCookie
          ? { auth: authNonSecuredCookie }
          : {}),
        ...(authNonSecuredImpersonate
          ? { impersonate: authNonSecuredImpersonate }
          : {}),
      },
      // @ts-ignore
      ...(!options.next && options.cache !== 'force-cache'
        ? { cache: options.cache || 'no-store' }
        : {}),
    });

    if (
      !params?.afterRequest ||
      (await params?.afterRequest?.(url, options, fetchRequest))
    ) {
      return fetchRequest;
    }

    // @ts-ignore
    return new Promise((res) => {}) as Response;
  };
};

export const fetchBackend = customFetch({
  get baseUrl() {
    return (
      process.env.BACKEND_URL ||
      process.env.BACKEND_INTERNAL_URL ||
      process.env.NEXT_PUBLIC_BACKEND_URL ||
      ''
    );
  },
});
