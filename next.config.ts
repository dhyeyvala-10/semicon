import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The whole experience is client-rendered 3D; no remote images or APIs are required.
  images: { unoptimized: true },
  devIndicators: false,
};

export default nextConfig;
