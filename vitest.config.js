import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		// Default to plain node; DOM-touching test files opt in via
		// a `// @vitest-environment jsdom` pragma at the top of the file.
		environment: 'node',
		// tokens.test.js and tokens-cache.test.js rely on per-file module
		// registries: the token cache in src/content/tokens.js is a module
		// singleton. Pin isolation so a future speed tweak can't break that.
		isolate: true,
		include: ['tests/**/*.test.js']
	}
});
