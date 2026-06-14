import tseslint from "typescript-eslint";
import unusedImports from "eslint-plugin-unused-imports";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "web/dist/**",
      "node_modules/**",
      "**/*.d.ts",
      "lines/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    plugins: {
      "unused-imports": unusedImports,
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
        Bun: "readonly",
      },
    },
    rules: {
      // Loosen a few defaults that don't fit this codebase's style.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      // The codebase uses `require()` in a few targeted spots (lazy/circular imports).
      "@typescript-eslint/no-require-imports": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],

      // Unused-imports plugin handles BOTH imports (auto-fixable) and vars.
      // Disable the core rule so this one takes over.
      "@typescript-eslint/no-unused-vars": "off",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "error",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
    },
  },
  {
    files: ["**/__tests__/**/*.ts", "**/*.test.ts"],
    rules: {
      // Tests intentionally use looser typing.
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
);
