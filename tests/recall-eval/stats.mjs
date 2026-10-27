/**
 * 评测的**统计层**（纯函数，无 I/O、无全局状态）。
 *
 * 为什么单独成文件：`sweep.mjs`（调参）与 `validate-holdout.mjs`（留出集一次性验证）都必须用
 * 同一套检验，若各写一份就会漂移——而漂移的后果是两个脚本对同一个差值给出不同裁决，
 * 那时没人知道该信哪个（今天已经吃过「同一读数两个口径」的亏）。
 *
 * 三条来自 2026-10-27 独立核验（澄 · 20300 个 (n,k) 组合全扫）的硬约束：
 *   ① **能力边界**：`n/0` split 给出上界 `z = (n−1)/√n`，解 `>1.96` ⇒ **n ≥ 6**。
 *      ⇒ 不一致对 ≤ 5 时，`mcnemar` **在数学上不可能报显著**（无论 split 多极端）。不是精度问题。
 *   ② **本实现是保守的**：n ≤ 200 全扫 ⇒ 假阳 0 例、漏报 12 例（全在 `p_exact ∈ [0.0488, 0.0499)`）。
 *      方向与「小样本近似偏激进」的通行担忧**相反**，因为 `−sign(·)` 把统计量往 0 拉。
 *   ③ **`z=0` 混淆两件事**： 「两臂打平」与「没有数据」。用 `empty` 旗标显式区分——
 *      否则调用方会把「这个评测集对该臂完全不敏感」读成「持平」。
 */

/** 标准正态 CDF（Abramowitz–Stegun 7.1.26，绝对误差 < 7.5e-8） */
export function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const d = 0.3989423 * Math.exp((-x * x) / 2)
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  return x > 0 ? 1 - p : p
}

/**
 * McNemar 配对检验：两臂在**同一批 case** 上的「对/错」是否真不同。
 *
 * 为什么必须配对：两个独立比例的差看的是 `sqrt(p(1-p)/n)`（216 case 约 3.2 个点），
 * 而配对只看「一个对一个错」的那部分（不一致对），噪声大幅抵消。
 *
 * @param {number[]} a - 臂 A 的逐 case 位图（1=top1 命中）
 * @param {number[]} b - 臂 B 的逐 case 位图（同序）
 * @returns `{ aOnly, bOnly, n, z, p, empty, significant }`
 *   `p` 为正态近似**双侧** p（精度：n ≥ 19 时 |Δp| < 0.003；n < 25 建议同时报精确二项）
 *   `empty` = 不一致对为 0 ⇒ **测不出**，不是持平
 */
export function mcnemar(a, b) {
  let aOnly = 0
  let bOnly = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] === 1 && b[i] === 0) aOnly += 1
    else if (a[i] === 0 && b[i] === 1) bOnly += 1
  }
  const n = aOnly + bOnly
  if (n === 0) return { aOnly, bOnly, n, z: 0, p: 1, empty: true, significant: false }
  const z = (aOnly - bOnly - Math.sign(aOnly - bOnly)) / Math.sqrt(n)
  return { aOnly, bOnly, n, z, p: 2 * (1 - normCdf(Math.abs(z))), empty: false, significant: Math.abs(z) > 1.96 }
}

/**
 * 配对设计的**检出率**（功效）：给定 n 与效应量，这台仪器能发现这个效应的概率。
 *
 * ⚠ `psi`（不一致率）是**假设值**（缺省 0.2，取自核验报告的实测量级），不是从评测集量出来的
 *   ⇒ 读数只给量级，不是精确功效。要精确就得先量 psi。
 */
export function powerPaired(n, delta, psi = 0.2) {
  const za = 1.959963985
  const num = delta * Math.sqrt(n) - za * Math.sqrt(psi)
  return normCdf(num / Math.sqrt(Math.max(psi - delta * delta, 1e-9)))
}

/** 独立两比例的检出率（不配对时的下界参考） */
export function powerIndependent(n, p0, delta) {
  const za = 1.959963985
  const p1 = p0 + delta
  const pbar = (p0 + p1) / 2
  const num = delta * Math.sqrt(n) - za * Math.sqrt(2 * pbar * (1 - pbar))
  return normCdf(num / Math.sqrt(p1 * (1 - p1) + p0 * (1 - p0)))
}

/** 反解：要可靠检出 `delta` 这个效应，需要多少 case（α=0.05、功效 0.8）——配对版 */
export function requiredNPaired(delta, psi = 0.2) {
  const za = 1.959963985
  const zb = 0.8416212336
  return Math.ceil(((za * Math.sqrt(psi) + zb * Math.sqrt(Math.max(psi - delta * delta, 1e-9))) ** 2) / (delta * delta))
}

/** 反解：独立两比例版（每臂的样本量） */
export function requiredNIndependent(p0, delta) {
  const za = 1.959963985
  const zb = 0.8416212336
  const p1 = p0 + delta
  const pbar = (p0 + p1) / 2
  return Math.ceil(
    ((za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(p1 * (1 - p1) + p0 * (1 - p0))) ** 2) / (delta * delta),
  )
}
