import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildSkillsPrompt, scanSkills } from '../src/skills/index.js';
import { dispatchTool, type ToolContext } from '../src/tools/dispatch.js';
import { tools } from '../src/tools/index.js';

describe('bundled skills', () => {
  it('defines commit + push as the default while retaining explicit opt-out and safety boundaries', async () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const skills = await scanSkills(root);
    const commit = skills.get('commit');
    expect(commit?.description).toContain('默认依次执行 git commit 和 git push');
    expect(commit?.description).toContain('仓库全部改动（用户指定范围时除外）');
    expect(commit?.body).toContain('默认执行 commit + push');
    expect(commit?.body).toContain('默认提交当前仓库的全部改动，包括已暂存、未暂存、未跟踪文件和删除');
    expect(commit?.body).toContain('用户明确指定文件、目录或“本次改动”等范围时，仅提交该范围');
    expect(commit?.body).toContain('在仓库根目录执行 `git add -A`');
    expect(commit?.body).toContain('不将密钥、`.env`、凭证或无关生成物纳入提交');
    expect(commit?.body).not.toContain('只提交用户指定或当前任务产生的改动');
    expect(commit?.body).toContain('“只提交”“不要推送”时仅 commit');
    expect(commit?.body).toContain('只要求 push 时不创建额外提交');
    expect(commit?.body).toContain('仅要求修改、调试或审查本 skill 时，不执行实际提交或推送');
    expect(commit?.body).toContain('不强推、不自动重写历史');
    expect(commit?.body).not.toContain('只要求 commit 时不 push');
    expect(commit?.body).not.toContain('推送（仅在用户明确要求时）');
  });

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
