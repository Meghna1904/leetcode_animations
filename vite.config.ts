import { defineConfig } from "vite";

export default defineConfig({
  // Keep built asset paths relative so the app also works on static hosts
  // that publish the site below a domain subpath.
  base: "/",
});

