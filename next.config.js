/** @type {import('next').NextConfig} */
const nextConfig = {
  // Increase timeout for static page generation
  staticPageGenerationTimeout: 120,
  
  // Optimize for serverless deployment on Render
  experimental: {
    esmExternals: 'loose',
  },
  
  // Configure webpack for better serverless performance
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Optimize for serverless
      config.externals.push('pg-native');
    }
    return config;
  },
  
  // Add headers for better API performance
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'no-store, must-revalidate',
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
