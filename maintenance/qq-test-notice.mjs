// Explicitly invoked test message to the sole configured private administrator.
// It uses REST only: it never opens a second QQ gateway connection.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { QQBot } from '../data/profiles/desktop/node_modules/@tencent-connect/qqbot-nodejs/dist/index.js';
const require=createRequire(import.meta.url);
const yaml=require('../data/profiles/desktop/node_modules/js-yaml');
const rows=yaml.load(fs.readFileSync(new URL('../data/profiles/desktop/cordis.patch.yml',import.meta.url),'utf8'));
const config=rows.find(x=>x.id==='im-qqbot').config;
if(config.access.c2cMode!=='allowlist'||config.access.c2cAllow.length!==1) throw Error('Test needs exactly one private administrator');
const bot=new QQBot({appId:config.appId,appSecret:config.appSecret,transport:'websocket',logger:{debug(){},info(){},warn(){},error(){}}});
try {
  await bot.sendMarkdown({scope:'c2c',targetId:config.access.c2cAllow[0]},
    'QQ 端到端自检准备中。请在这里回复“开始QQ自检”（让当前连接恢复会话）。随后将做两次只读插件清单查询：第一张审批卡点“拒绝”，第二张点“允许一次”。不会安装、删除或修改插件。');
  console.log('QQ test notice accepted by QQ API.');
} finally { bot.stop(); }
