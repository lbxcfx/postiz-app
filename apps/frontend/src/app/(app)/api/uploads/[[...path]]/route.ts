import { NextRequest, NextResponse } from 'next/server';
import { createReadStream, existsSync, statSync } from 'fs';
// @ts-ignore
import mime from 'mime';
import path from 'path';

const resolveUploadDirectory = (rawDirectory: string) => {
  const input = String(rawDirectory || '').trim();
  if (!input) {
    return '';
  }

  // Convert Windows drive path to WSL mount path when running on Linux.
  if (process.platform !== 'win32' && /^[a-zA-Z]:[\\/]/.test(input)) {
    const drive = input[0].toLowerCase();
    const rest = input
      .slice(2)
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');
    return path.posix.join('/mnt', drive, rest);
  }

  return path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
};
async function* nodeStreamToIterator(stream: any) {
  for await (const chunk of stream) {
    yield chunk;
  }
}
function iteratorToStream(iterator: any) {
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(new Uint8Array(value));
      }
    },
  });
}
export const GET = (
  request: NextRequest,
  context: {
    params: {
      path: string[];
    };
  }
) => {
  const segments = Array.isArray(context.params?.path) ? context.params.path : [];
  if (segments.length === 0) {
    return NextResponse.json({ message: 'path is required' }, { status: 400 });
  }
  if (
    segments.some(
      (segment) => !segment || segment.includes('..') || segment.includes('/') || segment.includes('\\')
    )
  ) {
    return NextResponse.json({ message: 'invalid path' }, { status: 400 });
  }

  const uploadRoot = resolveUploadDirectory(process.env.UPLOAD_DIRECTORY || '');
  if (!uploadRoot) {
    return NextResponse.json({ message: 'upload directory is not configured' }, { status: 500 });
  }

  const filePath = path.resolve(uploadRoot, ...segments);
  const rootPath = path.resolve(uploadRoot);
  if (!filePath.startsWith(rootPath)) {
    return NextResponse.json({ message: 'invalid path' }, { status: 400 });
  }
  if (!existsSync(filePath)) {
    return NextResponse.json({ message: 'file not found' }, { status: 404 });
  }

  try {
    const response = createReadStream(filePath);
    const fileStats = statSync(filePath);
    const contentType = mime.getType(filePath) || 'application/octet-stream';
    const iterator = nodeStreamToIterator(response);
    const webStream = iteratorToStream(iterator);
    return new Response(webStream, {
      headers: {
        'Content-Type': contentType,
        'Content-Length': fileStats.size.toString(),
        'Last-Modified': fileStats.mtime.toUTCString(),
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return NextResponse.json({ message: 'file read failed' }, { status: 500 });
  }
};
