import pleaseai from '@pleaseai/eslint-config'
import { sharedRules } from './eslint.rules'

export default pleaseai({
  type: 'app',
  ignores: [
    '**/dist',
    '**/node_modules',
    '**/coverage',
  ],
}, {
  rules: sharedRules,
})
