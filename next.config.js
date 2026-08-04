/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    optimizePackageImports: ["lucide-react"],
    // onnxruntime-node ships native .node binaries that must be loaded via
    // require() at runtime, not bundled by webpack.
    serverComponentsExternalPackages: ["onnxruntime-node"],
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**" },
    ],
  },
};

module.exports = nextConfig;
