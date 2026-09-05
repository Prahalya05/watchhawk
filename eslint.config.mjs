// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * Architecture boundaries, expressed as lint rules.
 *
 * The backend is organised as four rings (see docs/architecture.md). The whole point of
 * the arrangement is the direction of the arrows between them: dependencies point inward,
 * toward the stable business rules, never outward toward volatile detail. A folder name
 * records that intent; it does not enforce it. These rules do.
 *
 * `no-restricted-imports` matches the literal specifier text, which is sufficient here
 * because any relative path that reaches another ring must traverse that ring's directory
 * name — `../../infrastructure/db/prisma` contains "infrastructure" at every nesting
 * depth. The typescript-eslint variant is used rather than the base rule so that
 * `import type` is caught too: a type-only import of a vendor's wire format couples the
 * domain to that vendor just as firmly as a value import, and it was exactly how the
 * Gemini schema leaked into the assistant's vocabulary before this rule existed.
 */
const ring = (groups, message) => ({
  "no-restricted-imports": "off",
  "@typescript-eslint/no-restricted-imports": ["error", { patterns: [{ group: groups, message }] }],
});

const DETAIL_PACKAGES = ["express", "cors", "ws", "ioredis", "@prisma/client", "bcryptjs", "jsonwebtoken", "dotenv"];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "backend/prisma/migrations/**",
      "frontend/src/vite-env.d.ts",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ---------------------------------------------------------------- shared TS defaults
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: {
      // An unused parameter is usually a signature the code must keep (Express error
      // handlers need all four), so leading-underscore names are the opt-out rather than
      // a blanket exemption.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      eqeqeq: ["error", "smart"],
      "no-console": "off",
    },
  },

  // ------------------------------------------------------------------- backend: server
  {
    files: ["backend/**/*.ts"],
    languageOptions: { globals: { ...globals.node } },
  },

  // ------------------------------------------------------- ring 1: domain (innermost)
  // Pure business rules. Must compile with every framework, driver and vendor deleted.
  {
    files: ["backend/src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": "off",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/application/**", "**/infrastructure/**", "**/interfaces/**", "**/config/**"],
              message:
                "domain/ is the innermost ring: it may only import from domain/. Depending on a use case, a driver, a route or the environment inverts the arrow. Define a port in domain/ports/ and let the outer ring implement it.",
            },
          ],
          paths: DETAIL_PACKAGES.map((name) => ({
            name,
            message: `domain/ must not import ${name}. Business rules cannot depend on a specific framework, database driver or vendor SDK — that is what makes them testable without one.`,
          })),
        },
      ],
    },
  },

  // ------------------------------------------------------------- ring 2: application
  // Use cases. May orchestrate infrastructure, but must not know how it is delivered.
  {
    files: ["backend/src/application/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/interfaces/**"],
              message:
                "application/ must not import from interfaces/. A use case cannot depend on the delivery mechanism that invokes it.",
            },
          ],
          paths: ["express", "cors", "ws"].map((name) => ({
            name,
            message: `application/ must not import ${name}. Transport belongs in interfaces/; a use case takes plain arguments and returns plain values.`,
          })),
        },
      ],
    },
  },

  // ---------------------------------------------------------- ring 3: infrastructure
  // Concrete technology. Implements ports; never reaches back up the stack.
  {
    files: ["backend/src/infrastructure/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/application/**", "**/interfaces/**"],
              message:
                "infrastructure/ is a detail: it implements the ports the inner rings define and must not import a use case or a route. If an adapter needs to trigger a use case, have the use case call the adapter instead.",
            },
          ],
          paths: ["express", "cors"].map((name) => ({
            name,
            message: `infrastructure/ must not import ${name}. HTTP delivery lives in interfaces/.`,
          })),
        },
      ],
    },
  },

  // ------------------------------------------------------ ring 4: interfaces (outer)
  // Delivery. May use anything, except the database directly.
  {
    files: ["backend/src/interfaces/**/*.ts"],
    rules: ring(
      ["**/infrastructure/db/**"],
      "interfaces/ must not talk to Prisma or Redis directly. A route that queries a table knows that table's shape, so a schema change breaks the HTTP layer. Call an application/ service instead.",
    ),
  },

  // ------------------------------------------------------------------ backend: tests
  {
    files: ["backend/tests/**/*.ts"],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Tests exist to reach across boundaries and stub them out.
      "@typescript-eslint/no-restricted-imports": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },

  // --------------------------------------------------------------------- frontend: web
  {
    files: ["frontend/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // Deliberately the two long-standing rules rather than the plugin's current
      // `recommended` set. rules-of-hooks catches an actual crash (a hook behind a
      // condition changes hook order between renders); exhaustive-deps catches stale
      // closures. The newer additions in `recommended` (set-state-in-effect, refs) flag
      // patterns that are working correctly in this codebase, and turning them on would
      // mean rewriting live components during a structural change. Worth revisiting as
      // its own PR — see docs/adr/0004-lint-enforced-architecture-boundaries.md.
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },

  // -------------------------------------------------------------- config files (CJS/ESM)
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { globals: { ...globals.node } },
  },
);
