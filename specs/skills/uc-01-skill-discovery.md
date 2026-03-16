# UC-01: Skill Discovery & Filtering

## Trigger

System prompt is built for a bot (every conversation turn). The skills summary must reflect all available skills filtered by the bot's configuration.

## Expected Behavior

1. **Bundled skills loaded first**: `BUNDLED_SKILL_META` is iterated — metadata auto-extracted from SKILL.md frontmatter at build time
2. **Installed skills from D1**: Query `SELECT name, description, emoji, path, requires_env FROM skills` to get all installed skills
3. **No shadowing**: If an installed skill has the same name as a bundled skill, the installed version is skipped (bundled always wins)
4. **enabledSkills filtering (unified)**: If the bot has `enabledSkills` configured (non-empty array), ALL skills (bundled + installed) are filtered uniformly — only skills in that list are included
5. **adminOnly auto-visible**: Skills marked `adminOnly` (e.g. `system-reference`) are always visible to admin bots (`botType === "admin"`), even if not in `enabledSkills`
6. **Availability check** (bundled skills only): Bundled skills are checked against `AVAILABLE_BINS` set (curl, git, gh, jq, python3). Skills requiring unlisted bins are marked `available="false"`. Installed skills from D1 are always marked `available="true"` without binary checks
7. **XML summary built**: `buildSkillsSummaryXml()` produces `<skills>` XML with name, description, availability, and `<env>` tags showing configured status
8. **Skill secrets integration**: When `configuredSecrets` is provided, each skill's `requiresEnv` keys are checked — `<env configured="true"/>` if the key exists in secrets, `"false"` otherwise

## Install/Uninstall Auto-Enable

- **Install**: When a skill is installed (`install_skill` / `register_skill`), its name is automatically added to the target bot's `enabledSkills`
- **Uninstall**: When a skill is uninstalled (`unregister_skill` / `delete_skill`), its name is removed from the affected bot(s)' `enabledSkills`
- **Dashboard toggle**: Installed skills are toggled the same way as bundled skills in the dashboard — no auto-enable behavior

## Example

```
Bot config: enabledSkills = ["weather", "github", "humanizer"]
Bot type: normal
Installed skills in D1: [humanizer, pdf-reader]
Bundled skills: [weather, github, image, selfie, system-reference]

1. Bundled: weather, github, image, selfie, system-reference added to map
2. D1: humanizer added (not in bundled), pdf-reader added
3. enabledSkills filter: keep weather, github, humanizer
   (system-reference is adminOnly but bot is not admin -> filtered out)
   (image, selfie, pdf-reader not in enabledSkills -> filtered out)

Output XML:
<skills>
  <skill name="weather" available="true">
    <description>Get weather forecasts</description>
  </skill>
  <skill name="github" available="true">
    <description>GitHub operations</description>
  </skill>
  <skill name="humanizer" available="true">
    <description>Humanize AI text</description>
    <env name="HUMANIZER_API_KEY" configured="false"/>
  </skill>
</skills>
```

## Key Code Path

- Entry point: `buildSkillsSummaryWithD1(db, enabledSkills, isAdmin, configuredSecrets)` in `loader.ts`
- Skill listing: `listAllSkills(db, enabledSkills, isAdmin)` in `loader.ts`
- Bundled metadata: `BUNDLED_SKILL_META` array in `builtin.ts`, auto-extracted from `BUILTIN_SKILLS` map
- Metadata namespace resolution: `resolveMetadataNamespace()` in `metadata.ts` — checks `nanobot`, `openclaw`, `clawdbot` namespaces in order, falls back to raw object
- XML rendering: `buildSkillsSummaryXml(skills, configuredSecrets)` in `loader.ts`
- System prompt integration: `buildSystemPrompt()` in `context.ts` — Part 5 appends skills summary with usage instructions
- Skill secrets lookup: `getSkillSecretsForBot(db, ownerId, enabledSkills)` in `config.ts`

## Edge Cases

- **No enabledSkills configured**: All skills (bundled + installed) are included — no filtering applied
- **D1 query failure**: Gracefully falls back — only bundled skills are listed, warning logged
- **Empty skills list**: `buildSkillsSummaryXml()` returns `<skills>\n</skills>` — skills section still included in system prompt
- **Invalid requires_env JSON in D1**: Caught and logged, `requiresEnv` defaults to undefined for that skill
- **Metadata namespace mismatch**: If no known namespace found (`nanobot`, `openclaw`, `clawdbot`), the raw metadata object is used as fallback
- **XML escaping**: Skill names and descriptions are escaped via `escapeXml()` to prevent injection into the XML summary
- **Installed skill not in enabledSkills**: Skill exists in D1 but not in `enabledSkills` — not visible at runtime (user disabled it via dashboard)
