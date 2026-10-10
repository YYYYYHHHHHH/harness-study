import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildSkillsPrompt, scanSkills } from '../src/skills/index.js';
import { dispatchTool, type ToolContext } from '../src/tools/dispatch.js';
import { tools } from '../src/tools/index.js';

describe('bundled skills', () => {
  it('discovers and loads code_review and commit from the repository', async () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const skills = await scanSkills(root);
    const prompt = buildSkillsPrompt(skills);
    const context = { skills, tools } as ToolContext;

    for (const name of ['code_review', 'commit']) {
      const skill = skills.get(name);
      expect(skill).toBeDefined();
      expect(skill?.description).toBeTruthy();
      expect(skill?.body.trim()).toBeTruthy();
      expect(prompt).toContain(`"name": "${name}"`);
      const body = await dispatchTool('load_skill', JSON.stringify({ name }), context);
      expect(body).toBe(skill?.body);
      expect(body).not.toContain('\nname:');
    }
  });
});
