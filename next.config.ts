/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: { appDir: true },
  // Do NOT include: output: "export"
  // Avoid setting basePath unless you will call /<basePath>/api/...
};

export default nextConfig;