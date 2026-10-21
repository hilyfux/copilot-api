/**
 * Cross-process BillingDecision contract.
 *
 * Authoritative copy. Mirrored byte-identical at:
 *   claude-api/src/contracts/billing-decision.ts
 *   codex-api/src/contracts/billing-decision.ts
 *   kiro-api/src/contracts/billing-decision.ts
 *   byok-api/src/contracts/billing-decision.ts
 *
 * (The kiro/byok mirrors were undeclared here until 2026-07-28. They existed —
 * kiro's had already drifted in formatting — but nothing in this header said
 * to keep them in step, which is exactly how a "byte-identical mirror" stops
 * being one.)
 *
 * Returned by each proxy's `BillingGate.check(keyHash)` to decide whether
 * to forward an authenticated request to its upstream provider. The
 * gateway has no consumer of this type yet — it owns the `user_billing_state`
 * writes that produce the underlying state, but it doesn't make per-request
 * decisions itself. The type is stored here so future gateway features
 * (admin "preview decision" tool, batch reconciliation) can import it
 * without depending on a proxy repo.
 */
/**
 * Window slug identifying which subscription bucket tripped the gate.
 * '30d' is the legacy single-period (monthly) bucket; '5h' / '7d' come
 * from migration 026 (multi-window plans).
 */
export type QuotaWindow = '5h' | '7d' | '30d'

export type BillingDecision =
  | { allowed: true; reason?: undefined }
  | {
      allowed: false
      reason: 'insufficient_balance'
      userId: string
      /** 2026-07-28 (mig 099) widened from `'pay_per_token'` to include
       *  `'subscription'`: a subscription user can now sit on the **balance
       *  lane** (`charge_preference='balance'`), or overflow onto it from an
       *  exhausted plan/token-pack lane. Either way an empty wallet is
       *  "no money", not "quota used up" — before this widening the proxies
       *  had to mislabel it `quota_exceeded`, telling the user to wait for a
       *  window reset that would not help. Expand-only: `'pay_per_token'`
       *  still type-checks, so existing consumers are untouched. */
      mode: 'pay_per_token' | 'subscription'
    }
  /**
   * 套餐额度已耗尽，且该用户未开启「超量后使用余额」(mig 096 的
   * `allow_balance_overflow=0`)。**与余额多少无关 —— 有钱也拒**，那正是这个
   * 开关存在的意义：用户明确说了「用完即停」。
   *
   * 与 `quota_exceeded` 分开是因为**补救动作不同**：那条等窗口重置就好；
   * 这条等到窗口重置也一样，但用户可能更想去把开关打开。带上 `resetAt` 是
   * 因为订阅窗口确实会滚。
   */
  | {
      allowed: false
      reason: 'plan_exhausted_overflow_off'
      userId: string
      mode: 'subscription'
      /** 窗口下次重置的绝对时刻（ISO-8601 UTC，服务端时钟）。可缺省。 */
      resetAt?: string
    }
  /**
   * token 套餐已用光，且未开启「超量后使用余额」(mig 099)。
   *
   * **没有 `resetAt`，这是刻意的**：token 套餐没有时间约束，不滚窗口、不到期。
   * 给它一个重置时刻等于让用户对着一个永远不会到来的时间点干等 —— 唯一的
   * 出路是再充一包 token，或者打开超量开关。在此之前 proxy 只能借用
   * `token_quota_exceeded`，那条自带「等日重置」的语义，是错误的指引。
   */
  | {
      allowed: false
      reason: 'token_pack_exhausted_overflow_off'
      userId: string
      // 2026-08-24: pay_per_token 也可停在 token_pack 档（mig 096 ppt lane）。expand-only 加成员，旧消费者按 reason 分派不受影响。
      mode: 'subscription' | 'pay_per_token'
    }
  | {
      allowed: false
      reason: 'quota_exceeded'
      userId: string
      mode: 'subscription'
      /** Which window's quota was exceeded. Always present for
       *  reason='quota_exceeded'. */
      window: QuotaWindow
      /** Server-authoritative absolute instant (ISO-8601 UTC) when this
       *  window next resets = started_at + window duration. Derived purely
       *  from the server clock (MySQL-stamped started_at), NEVER from any
       *  client-supplied time — a downstream cannot extend its window by
       *  changing its device clock. Optional: omitted only when started_at
       *  is unexpectedly NULL. Clients localise it for display. */
      resetAt?: string
    }
  | {
      allowed: false
      reason: 'token_quota_exceeded'
      userId: string
      /** The user's actual billing mode. Since mig 051 token quotas
       *  (daily_token_quota + monthly_token_quota) are UNIVERSAL plan knobs —
       *  enforced for every mode, no longer credits_seat-only. */
      mode: 'subscription' | 'pay_per_token' | 'credits_seat'
      /** Server-authoritative ISO-8601 UTC reset instant = window started_at
       *  + window duration (1d daily / 30d monthly — mig 051). Cheat-proof
       *  (never client time). Optional if started_at is NULL. */
      resetAt?: string
    }
