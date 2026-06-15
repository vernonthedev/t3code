import { defineConfig } from "astro/config";

export default defineConfig({
  server: {
    port: Number(process.env.PORT ?? 4173),
  },
  vite: {
    plugins: [
      {
        name: "fix-deprecated-esbuild-options",
        config(config) {
          if (config.optimizeDeps?.esbuildOptions) {
            config.optimizeDeps.rolldownOptions ??= {};
            config.optimizeDeps.rolldownOptions.plugins ??= [];
            config.optimizeDeps.rolldownOptions.plugins.push(
              ...config.optimizeDeps.esbuildOptions.plugins,
            );
            delete config.optimizeDeps.esbuildOptions;
          }
        },
      },
    ],
  },
});
