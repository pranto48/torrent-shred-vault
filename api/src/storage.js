import { Client } from 'minio';

const bucket = process.env.MINIO_BUCKET ?? 'vault-data';

export const minioClient = new Client({
  endPoint: process.env.MINIO_ENDPOINT ?? 'minio',
  port: Number(process.env.MINIO_PORT ?? 9000),
  useSSL: (process.env.MINIO_USE_SSL ?? 'false') === 'true',
  accessKey: process.env.MINIO_ACCESS_KEY ?? 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY ?? 'minioadmin123',
});

export async function ensureBucket() {
  const exists = await minioClient.bucketExists(bucket).catch(() => false);
  if (!exists) await minioClient.makeBucket(bucket, 'us-east-1');
}

export function getBucketName() {
  return bucket;
}
