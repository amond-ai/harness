/**
 * Build the `pleaseworks` e2b template from the image CI publishes (#385).
 *
 * e2b's prebuilt `claude` template carries no `/opt/turn-host`, so the default
 * `TURN_DRIVER=sdk` cannot run on it. `docker/Dockerfile`'s `e2b-sandbox` stage does carry
 * it; `.github/workflows/docker-sandbox.yml` publishes that stage to
 * `ghcr.io/chatbot-pf/pleaseworks-e2b`, and this script turns it into a template alias.
 *
 * ```sh
 * # From the published image. Private, so e2b's builder needs a GHCR login of its own.
 * infisical run --silent -- env GHCR_USERNAME=<login> GHCR_TOKEN=<read:packages token> \
 *   E2B_TEMPLATE_ALIAS=pleaseworks-candidate bun packages/amond-ai/sandbox-e2b/scripts/build-template.ts
 *
 * # Promote: repoint the live alias at a candidate that has already booted. No registry.
 * infisical run --silent -- env E2B_TEMPLATE_ALIAS=pleaseworks \
 *   E2B_TEMPLATE_FROM=pleaseworks-candidate bun packages/amond-ai/sandbox-e2b/scripts/build-template.ts
 * ```
 *
 * The alias it prints is what `E2B_TEMPLATE` in `apps/cf-orchestrator/wrangler.jsonc` must
 * name — a Worker pointed at a template this script never built boots e2b's stock image
 * and the turn host is simply not there.
 *
 * Everything has a default — see `resolveTemplateBuildConfig`.
 */
import process from 'node:process'
import { defaultBuildLogger, Template } from 'e2b'
import { resolveTemplateBuildConfig } from '../src/template-config'

const config = resolveTemplateBuildConfig(process.env)

const { source } = config
const template = source.kind === 'template'
  ? Template().fromTemplate(source.name)
  : Template().fromImage(source.image, {
      username: source.registry.username,
      password: source.registry.password,
    })

await Template.build(template, config.alias, {
  cpuCount: config.cpuCount,
  memoryMB: config.memoryMB,
  onBuildLogs: defaultBuildLogger(),
})

const from = source.kind === 'template' ? `template:${source.name}` : source.image
console.log(`built e2b template alias=${config.alias} from=${from}`)
