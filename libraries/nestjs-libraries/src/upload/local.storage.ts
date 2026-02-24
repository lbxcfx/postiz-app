import { IUploadProvider } from './upload.interface';
import { mkdirSync, unlink, writeFileSync } from 'fs';
// @ts-ignore
import mime from 'mime';
import path, { extname } from 'path';
import axios from 'axios';

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

export class LocalStorage implements IUploadProvider {
  private readonly uploadDirectory: string;

  constructor(uploadDirectory: string) {
    this.uploadDirectory = resolveUploadDirectory(uploadDirectory);
  }

  async uploadSimple(url: string) {
    const loadImage = await axios.get(url, { responseType: 'arraybuffer' });
    const contentType =
      loadImage?.headers?.['content-type'] ||
      loadImage?.headers?.['Content-Type'];
    const findExtension = mime.getExtension(contentType)!;

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');

    const innerPath = `${year}/${month}/${day}`;
    const dir = path.join(this.uploadDirectory, innerPath);
    mkdirSync(dir, { recursive: true });

    const randomName = Array(32)
      .fill(null)
      .map(() => Math.round(Math.random() * 16).toString(16))
      .join('');

    const fileName = `${randomName}.${findExtension}`;
    const filePath = path.join(dir, fileName);
    const publicPath = `/${innerPath}/${fileName}`.replace(/\\/g, '/');
    // Logic to save the file to the filesystem goes here
    writeFileSync(filePath, loadImage.data);

    return process.env.FRONTEND_URL + '/uploads' + publicPath;
  }

  async uploadFile(file: Express.Multer.File): Promise<any> {
    try {
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');

      const innerPath = `${year}/${month}/${day}`;
      const dir = path.join(this.uploadDirectory, innerPath);
      mkdirSync(dir, { recursive: true });

      const randomName = Array(32)
        .fill(null)
        .map(() => Math.round(Math.random() * 16).toString(16))
        .join('');

      const fileName = `${randomName}${extname(file.originalname)}`;
      const filePath = path.join(dir, fileName);
      const publicPath = `/${innerPath}/${fileName}`.replace(/\\/g, '/');

      // Logic to save the file to the filesystem goes here
      writeFileSync(filePath, file.buffer);

      return {
        filename: fileName,
        path: process.env.FRONTEND_URL + '/uploads' + publicPath,
        mimetype: file.mimetype,
        originalname: file.originalname,
      };
    } catch (err) {
      console.error('Error uploading file to Local Storage:', err);
      throw err;
    }
  }

  async removeFile(filePath: string): Promise<void> {
    // Logic to remove the file from the filesystem goes here
    return new Promise((resolve, reject) => {
      unlink(filePath, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }
}
