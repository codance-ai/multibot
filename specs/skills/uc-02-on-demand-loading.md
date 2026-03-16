# UC-02: On-Demand Loading (load_skill)

## Trigger

Bot calls the `load_skill(name)` tool during a conversation turn. This happens when the bot identifies a user request that matches a skill listed in the `<skills>` XML summary in its system prompt.

## Expected Behavior

1. **Bot checks `<skills>` list**: Before replying, the bot scans its skills summary. If a skill matches the user's request, it calls `load_skill(name)` first
2. **Builtin routing (fast path)**: If `name` exists in `BUILTIN_SKILLS` map, the full SKILL.md content is returned immediately from in-memory — no network I/O
3. **Installed routing (R2 path)**: If not builtin, and R2 is available:
   a. `ensureSkillReady(name)` is called to trigger lazy hydration (see UC-03)
   b. SKILL.md content is fetched from R2 at `installed-skills/{name}/SKILL.md`
   c. Full content (frontmatter + body) is returned
4. **Skill not found**: Returns `Error: Skill "{name}" not found.`
5. **Hydration failure**: Returns `Error: Skill "{name}" is not available: {error message}`
6. **Bot follows skill instructions**: After loading, the bot follows the instructions in the SKILL.md body (frontmatter is included but the bot focuses on the markdown body)

## Example

```
System prompt contains:
<skills>
  <skill name="weather" available="true">
    <description>Get weather forecasts</description>
  </skill>
  <skill name="humanizer" available="true">
    <description>Humanize AI text</description>
  </skill>
</skills>

User: "What's the weather in Tokyo?"

Bot reasoning:
  -> "weather" skill matches this request
  -> Call load_skill("weather")

load_skill("weather"):
  -> "weather" found in BUILTIN_SKILLS
  -> Return full SKILL.md content (frontmatter + instructions)

Bot follows weather skill instructions (e.g. calls exec to fetch weather data)
```

```
User: "Can you humanize this text?"

Bot reasoning:
  -> "humanizer" skill matches
  -> Call load_skill("humanizer")

load_skill("humanizer"):
  -> Not in BUILTIN_SKILLS
  -> ensureSkillReady("humanizer") -> hydration (see UC-03)
  -> R2.get("installed-skills/humanizer/SKILL.md") -> content returned

Bot follows humanizer skill instructions
```

## Key Code Path

- Tool definition: `createLoadSkillTool(builtinSkills, r2, ensureSkillReady)` in `load-skill.ts`
- Builtin lookup: Direct key access on `BUILTIN_SKILLS` record in `builtin.ts`
- R2 fetch: `r2.get(\`installed-skills/${name}/SKILL.md\`)` in `load-skill.ts`
- Hydration trigger: `ensureSkillReady(name)` from `ensure-ready.ts` (see UC-03)
- System prompt instruction: `buildSystemPrompt()` in `context.ts` tells bot to "call load_skill(name) first, then follow its instructions"

## Edge Cases

- **Skill name not in `<skills>` list**: Bot may still call `load_skill` with an arbitrary name — it will return "not found" for unknown names
- **R2 not available**: If `r2` binding is not provided to the tool factory, only builtin skills can be loaded
- **ensureSkillReady not provided**: Hydration is skipped — R2 content is still fetched but sandbox may not have the skill's files or dependencies installed
- **Concurrent load_skill calls for same skill**: Hydration dedup ensures only one hydration runs (see UC-03)
- **Skill content format**: Full SKILL.md is returned including YAML frontmatter — the bot sees both metadata and instructions
