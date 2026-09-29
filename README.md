# harness-study

一个 TypeScript 环境，一个 OpenAI 调用示例：`src/index.ts`。

需要 Node.js 22.9+。

```bash
npm install
cp .env.example .env
```

在 `.env` 填写 `OPENAI_API_KEY` 和账号可用的模型 ID `OPENAI_MODEL`，然后运行：

```bash
npm start
```

修改 `src/index.ts` 中的 `input` 即可更换问题。`npm run check` 检查 TypeScript 类型。

示例调用 Responses API，会使用你的 API 额度。[OpenAI 官方 SDK 文档](https://developers.openai.com/api/docs/libraries)
