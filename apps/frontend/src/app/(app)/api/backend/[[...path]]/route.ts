import { NextRequest, NextResponse } from 'next/server';

const PASS_THROUGH_REQUEST_HEADERS = [
  'content-type',
  'accept',
  'authorization',
  'x-copilotkit-runtime-client-gql-version',
  'sentry-trace',
  'baggage',
  'auth',
  'showorg',
  'impersonate',
];

const PASS_THROUGH_RESPONSE_HEADERS = [
  'content-type',
  'reload',
  'onboarding',
  'activate',
  'logout',
  'auth',
  'showorg',
  'impersonate',
];

const getBackendBaseUrl = () =>
  (
    process.env.BACKEND_INTERNAL_URL ||
    process.env.NEXT_PUBLIC_BACKEND_URL ||
    process.env.BACKEND_URL ||
    ''
  ).trim();

const buildTargetUrl = (
  request: NextRequest,
  context: { params: { path?: string[] } },
  backendBaseUrl: string
) => {
  const path = (context.params.path || []).join('/');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const target = new URL(normalizedPath, backendBaseUrl);
  request.nextUrl.searchParams.forEach((value, key) => {
    target.searchParams.append(key, value);
  });
  return target.toString();
};

const buildRequestHeaders = (request: NextRequest) => {
  const headers = new Headers();
  for (const key of PASS_THROUGH_REQUEST_HEADERS) {
    const value = request.headers.get(key);
    if (value) {
      headers.set(key, value);
    }
  }
  if (!headers.get('auth')) {
    const authCookie = request.cookies.get('auth')?.value;
    if (authCookie) {
      headers.set('auth', authCookie);
    }
  }
  if (!headers.get('showorg')) {
    const showorgCookie = request.cookies.get('showorg')?.value;
    if (showorgCookie) {
      headers.set('showorg', showorgCookie);
    }
  }
  if (!headers.get('impersonate')) {
    const impersonateCookie = request.cookies.get('impersonate')?.value;
    if (impersonateCookie) {
      headers.set('impersonate', impersonateCookie);
    }
  }
  return headers;
};

const proxy = async (
  request: NextRequest,
  context: { params: { path?: string[] } }
) => {
  const backendBaseUrl = getBackendBaseUrl();
  if (!backendBaseUrl) {
    return NextResponse.json(
      { message: 'Backend URL is not configured' },
      { status: 500 }
    );
  }

  const targetUrl = buildTargetUrl(request, context, backendBaseUrl);
  const method = request.method.toUpperCase();
  const body =
    method === 'GET' || method === 'HEAD' ? undefined : await request.text();
  let backendResponse: Response;
  try {
    backendResponse = await fetch(targetUrl, {
      method,
      headers: buildRequestHeaders(request),
      body: body && body.length > 0 ? body : undefined,
      cache: 'no-store',
    });
  } catch (error) {
    return NextResponse.json(
      {
        message:
          error instanceof Error
            ? error.message
            : 'backend request failed',
      },
      { status: 502 }
    );
  }

  const responseHeaders = new Headers();
  for (const key of PASS_THROUGH_RESPONSE_HEADERS) {
    const value = backendResponse.headers.get(key);
    if (value) {
      responseHeaders.set(key, value);
    }
  }

  return new NextResponse(await backendResponse.text(), {
    status: backendResponse.status,
    headers: responseHeaders,
  });
};

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
