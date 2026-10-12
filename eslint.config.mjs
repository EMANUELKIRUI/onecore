import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "node_modules/**", "coverage/**"] },
  eslint.configs.recommended,
  {
    files: [
      "apps/business/**/*.js",
      "apps/marketing/**/*.js",
      "apps/superadmin/**/*.js",
      "apps/support/**/*.js",
      "packages/ui/**/*.js",
    ],
    languageOptions: {
      globals: {
        document: "readonly",
        fetch: "readonly",
        FormData: "readonly",
        HTMLDialogElement: "readonly",
        location: "readonly",
        Response: "readonly",
        URLSearchParams: "readonly",
        window: "readonly",
      },
    },
  },
  ...tseslint.configs.recommended,
);
