/**
 * Build the `pleaseworks` e2b template from the image CI publishes (#385).
 *
 * e2b's prebuilt `claude` template carries no `/opt/turn-host`, so the default
 * `TURN_DRIVER=sdk` cannot run on it. `docker/Dockerfile`'s `e2b-sandbox` stage does carry
 * it; `.github/workflows/docker-sandbox.yml` publishes that stage to
 * `ghcr.io/chatbot-pf/pleaseworks-e2b`, and this script turns it into a template alias.
 *
 * ```sh
 * infisical run --silent -- env GHCR_USERNAME=<login> GHCR_TOKEN=<read:packages token> \
 *   bun packages/sandbox-e2b/scripts/build-template.ts
 * ```
 *
 * The alias it prints is what `E2B_TEMPLATE` in `apps/cf-orchestrator/wrangler.jsonc` must
 * name — a Worker pointed at a template this script never built boots e2b's stock image
 * and the turn host is simply not there.
 *
 * `GHCR_USERNAME`/`GHCR_TOKEN` are required because the image is private: e2b pulls it
 * from its own builder, not from a machine that is already `docker login`ed. Everything
 * else has a default — see `resolveTemplateBuildConfig`.
 */
import process from 'node:process'
import { defaultBuildLogger, Template } from 'e2b'
import { resolveTemplateBuildConfig } from '../src/template-config'

const config = resolveTemplateBuildConfig(process.env)

const template = Template().fromImage(config.image, {
  username: config.registry.username,
  password: config.registry.password,
})

await Template.build(template, config.alias, {
  cpuCount: config.cpuCount,
  memoryMB: config.memoryMB,
  onBuildLogs: defaultBuildLogger(),
})

console.log(`built e2b template alias=${config.alias} image=${config.image}`)
