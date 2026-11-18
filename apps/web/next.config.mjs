/** 本番は静的に出力して Firebase Hosting で配信（04 1.1）。開発では /api を NestJS（:4000）へ転送する */
const isDev = process.env.NODE_ENV !== 'production';
/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(isDev ? {} : { output: 'export' }),
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
  ...(isDev ? { skipTrailingSlashRedirect: true, async rewrites() { return [{ source: '/api/:path*', destination: `${process.env.API_ORIGIN ?? 'http://localhost:4000'}/api/:path*` }]; } } : {}),
};
export default nextConfig;
