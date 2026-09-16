# NestJS 迁移记录

迁移基线为 `4414749`。继续采用 ADR 0001 的单上下文 DDD 模块化单体，保留 SQLite、文件附件、React 和现有 HTTP 契约。

## 运行与验证

已采用 Node 24.15.0、TypeScript 7.0.2、NestJS 12.0.3 与 Express 适配器。使用 TypeScript 编译装饰器与 ESM，生产启动执行编译后的 JavaScript；API 与浏览器测试也加载同一后端产物。

```sh
npm run build
npm start
npm run test:api
npm run test:ui
node --import tsx scripts/verify-upgrade.mjs
```

开发使用 `npm run dev` 监听后端编译产物；修改前端后仍需构建前端。后端产物位于 `build/server`，前端位于 `dist`。PORT、DAILY_DATABASE_PATH、DAILY_SETUP_KEY 的语义及默认本机监听保持不变。

应用创建变为异步，返回异步 `listen` 与幂等 `close`。每个应用实例有独立的资源所有者，所有仓储共享一条 SQLite 连接，正常关闭与初始化失败均由所有者释放连接。领域和应用类通过工厂 Provider 接入 Nest，不需要框架装饰器。

## 逐项进度

| 任务 | 状态   | 入口                                                                                        |
| ---- | ------ | ------------------------------------------------------------------------------------------- |
| 01   | 已完成 | 初始化、登录、当前身份、退出；24 项接口/运行检查与 9 项页面回归通过，旧数据升级回退通过     |
| 02   | 已完成 | 6 项成员邀请接口与 2 项浏览器流程通过；旧邀请、会话及数据升级回退验证通过。                 |
| 03   | 已完成 | 7 项项目、任务与归档接口验收通过；任务切换页面回归通过；类型、编译和架构检查通过。          |
| 04   | 已完成 | 12 项接口/运行检查、5 项页面流程与旧数据升级回退通过；补充并修复错误 JSON 返回 400 的回归。 |
| 05   | 实施中 | 分享暂用过渡适配                                                                            |
| 06   | 待实施 | 附件暂用过渡适配                                                                            |
| 07   | 待实施 | 删除过渡适配、完整兼容与回归                                                                |

过渡适配与 Nest 共用应用用例及资源，不为旧入口重新创建数据库。已经迁移的路由不在旧适配中注册，错误映射和安全中间件共用一套。

## 升级与回退验证

兼容脚本从 Git 基线取出旧服务，在隔离目录通过 HTTP 创建数据，关闭后交给当前版本读取和写入，再由旧服务读取新数据。覆盖未过期会话、密码、邀请、私人草稿、待重提修改、回执重放、任务历史、三类分享和附件。脚本需要 Git 历史及开发依赖，不接触真实业务数据，结束后删除自己的临时目录。

官方参考：[Nest 12 迁移指南](https://docs.nestjs.com/migration-guide)、[工厂 Provider](https://docs.nestjs.com/fundamentals/custom-providers)、[异常 Filter](https://docs.nestjs.com/exception-filters)。

## 浏览器环境

本机 Edge 在不启动应用的情况下，连续创建并关闭浏览器上下文时第二次新建页面会超时；禁用 GPU 后仍可复现。测试默认仍使用 Edge，可通过 `PLAYWRIGHT_CHANNEL=chromium` 使用与 Playwright 配套的无头 Chromium，先运行 `npx playwright install chromium --only-shell`。也可用 `PLAYWRIGHT_EXECUTABLE_PATH` 指定本机浏览器用于诊断。页面断言未删减，后端迁移不依赖此选项。
