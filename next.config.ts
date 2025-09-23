/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    // Let the build succeed even if there are ESLint errors.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;