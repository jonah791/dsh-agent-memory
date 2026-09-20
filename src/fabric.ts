/**
 * Fabric host entrypoint 骨架（DSH Community Fabric · RFC 0001 v0.1 · 由 dsh-plugin-forge 生成）。
 *
 * ⚠ **现在不可运行**：Fabric 仍只有文档——没有 SDK、没有正式 schema、没有 runtime（RFC 0001 §1 Draft 边界）。
 * 本文件按 §7.1（entrypoint 独立于 DSH/Cordis）+ §7.5（未来 SDK 形态）预留；SDK 发布后在 activate 内按
 * 协商到的 capability 绑定实现。**在此之前不得声称本插件通过 Fabric conformance**（RFC §13：只有
 * 存在 v0.1 plugin validation 套件时才可如此声称）。
 *
 * **两个面（别混）**：本文件只承载 **Fabric 契约面**（前瞻声明）。本插件**实际可运行的功能**在 DSH/Cordis 面
 * （`src/index.ts` + `cordis.patch.yml`）——那是**非标准扩展路径**：那里的 cordis service 与 `tools` 不在
 * Fabric v0.1 capability 表内，本文件既不声明也不调用它们；**本骨架不代表本插件能在 Fabric Host 上运行**。
 *
 * 纪律（生成物自带守卫会逐条检查）：
 *   1. 不 import `@deepseek-ai/*`、不 import `cordis`（§7.1：Fabric entrypoint 运行时不依赖 DSH/Cordis）
 *   2. 只使用 manifest 已声明的 capability（未声明的不调）
 *   3. 清理必须**可重复**（§7.4：同一 entrypoint 可能被重复 activate，deactivate 不保证送达）
 */

export interface FabricActivationContext {
  /** 基础 context（每次 activation 都有，非协商 capability）：host.info / log / 生命周期取消信号 */
  readonly host?: { readonly id?: string; readonly version?: string }
  readonly log?: { info(message: string, fields?: Record<string, unknown>): void }
}

export interface FabricActivation {
  /** Host 正常关闭时 best-effort 调用；必须幂等（§7.4） */
  deactivate?(): void | Promise<void>
}

export const fabricPluginId = "com.jonah791.agent-memory"

export default function activate(ctx: FabricActivationContext): FabricActivation {
  ctx.log?.info("dsh-agent-memory activated (Fabric skeleton)")
  // manifest 未声明 contributes.commands。
  // TODO(Fabric SDK)：SDK 发布后按 §7.5 形态实现，例如
  //   ctx.commands?.handle(fabricPluginId + '.show', async () => { ... })
  //   ctx.messages?.onReceived(async (message) => { ... })
  return {
    deactivate() {
      // TODO：释放本 activation 持有的资源（须可重复调用）
    },
  }
}
