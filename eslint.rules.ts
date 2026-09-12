import type { Rules } from '@pleaseai/eslint-config'

/**
 * Rule overrides shared by every eslint.config.ts in the monorepo — the root one and
 * apps/dashboard's, which shadows the root for its own tree. Keep them importing this
 * single object so the two configs cannot drift (#243, PR #247 review).
 */
export const sharedRules: Rules = {
  // The default (allowWhitespace: false) reads a line-leading `*emphasis*` as a doubled
  // asterisk and its autofix strips the opening `*`, corrupting intentional JSDoc emphasis
  // on every `lint:fix` run (#243). allowWhitespace checks the delimiter-adjacent run only,
  // which still catches delimiter-adjacent `** text` typos and multi-line `**/` endings.
  // Accepted trade-offs of allowWhitespace: true (verified against the rule, v62.9.0):
  // the end-line check goes silent for single-line blocks (`/** text ** */` no longer
  // warns), and ANY whitespace-separated `* text` middle line passes, not only markdown
  // emphasis — e.g. a stray duplicated `* ` fragment from a bad merge.
  'jsdoc/no-multi-asterisks': ['warn', { allowWhitespace: true }],
}
