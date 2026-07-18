import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@fieldquote/ui', '@fieldquote/shared-types'],
};

export default nextConfig;
