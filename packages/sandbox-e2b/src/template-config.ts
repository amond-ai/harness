/**
 * What a template build needs, read off the environment and checked before anything is
 * dialed (#385).
 *
 * Split from `scripts/build-template.ts` so the parsing is reachable without the e2b SDK
 * and without a network: the script is a thin caller, this is where the decisions are.
 *
 * Every failure here is a message naming the variable, because the alternative shapes are
 * all worse than a refusal — an unset `GHCR_TOKEN` reaches e2b as an anonymous pull of a
 * *private* image and comes back as a build failure with no hint of which credential was
 * missing, and a non-numeric `E2B_TEMPLATE_CPU` would otherwise become a `NaN` the SDK
 * forwards as a sandbox spec.
 */

/** e2b's own defaults are 2 CPUs / 1024 MB; the memory is raised because a turn hosts the SDK. */
const DEFAULT_IMAGE = 'ghcr.io/chatbot-pf/pleaseworks-e2b:latest'
const DEFAULT_ALIAS = 'pleaseworks'
const DEFAULT_CPU_COUNT = 2
const DEFAULT_MEMORY_MB = 4096

export interface TemplateBuildConfig {
  /** The published image the template is built from. */
  image: string
  /** The template name a Worker names in `E2B_TEMPLATE`. */
  alias: string
  cpuCount: number
  memoryMB: number
  /** GHCR credentials — the image is private, so an anonymous pull cannot resolve it. */
  registry: { username: string, password: string }
}

export function resolveTemplateBuildConfig(env: Record<string, string | undefined>): TemplateBuildConfig {
  // Not returned: the e2b SDK reads it off the environment itself. Checked here anyway, so a
  // missing key is a refusal before the image is pulled rather than an auth error after it.
  required(env, 'E2B_API_KEY')
  return {
    image: env.E2B_TEMPLATE_IMAGE?.trim() || DEFAULT_IMAGE,
    alias: env.E2B_TEMPLATE_ALIAS?.trim() || DEFAULT_ALIAS,
    cpuCount: positiveInt(env.E2B_TEMPLATE_CPU, 'E2B_TEMPLATE_CPU', DEFAULT_CPU_COUNT),
    memoryMB: positiveInt(env.E2B_TEMPLATE_MEMORY_MB, 'E2B_TEMPLATE_MEMORY_MB', DEFAULT_MEMORY_MB),
    registry: {
      username: required(env, 'GHCR_USERNAME'),
      password: required(env, 'GHCR_TOKEN'),
    },
  }
}

/** The value, never echoed on failure — two of these three are credentials. */
function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim()
  if (!value) {
    throw new Error(`${name} is not set: building the e2b template needs it`)
  }
  return value
}

function positiveInt(raw: string | undefined, name: string, fallback: number): number {
  const value = raw?.trim()
  if (!value) {
    return fallback
  }
  const parsed = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} has a non-positive-integer value '${value}'`)
  }
  return parsed
}
