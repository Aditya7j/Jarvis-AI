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
    // Starts the background task scheduler (instrumentation.ts) once per
    // server process, replacing the deleted Fastify sidecar.
    instrumentationHook: true,
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**" },
    ],
  },
  // instrumentation.ts compiles for BOTH the node and edge runtimes. Our task
  // scheduler imports node builtins (fs/path/crypto) that the edge target
  // cannot resolve, so externalize them there — the edge `register()` guard
  // returns before that code is ever imported at runtime.
  webpack: (config, { nextRuntime }) => {
    if (nextRuntime === "edge") {
      const nodeBuiltins = [
        "fs", "path", "crypto", "os", "net", "tls", "child_process",
        "stream", "util", "http", "https", "url", "zlib", "buffer",
        "worker_threads", "readline", "querystring", "string_decoder",
        "dns", "dgram", "tty", "timers", "events", "assert", "constants",
      ];
      const externals = Object.fromEntries(
        nodeBuiltins.map((mod) => [mod, `commonjs ${mod}`])
      );
      config.externals = [...(config.externals || []), externals];
    }
    return config;
  },
};

module.exports = nextConfig;
