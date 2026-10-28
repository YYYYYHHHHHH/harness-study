// The CLI runs TypeScript directly; worker threads need their own tsx registration.
import { tsImport } from 'tsx/esm/api';
await tsImport('./worker.ts', import.meta.url);
