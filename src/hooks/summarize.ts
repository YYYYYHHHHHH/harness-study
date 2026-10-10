import chalk from 'chalk';
import { registerHook } from './index.js';

registerHook('Stop', ({ rounds, finished, finalContent, logPrefix }) => {
  console.log(
    chalk.gray(
      `${logPrefix ? logPrefix + ' ' : ''}[stop] Agent ${finished ? '正常结束' : '未完成'}，共执行 ${rounds} 轮${finalContent ? `，最终输出 ${finalContent.length} 字符` : ''}`,
    ),
  );
});
