/**
 * MVP job cost policy — all numeric fields are in **credits** (abstract units),
 * not KRW/USD or any fiat currency.
 */

export type MvpCostJobType = 'analyze' | 'build_identity' | 'preview'

export type MvpJobCostPolicy = {
  cost_estimate: number
  cost_accumulated: number
  soft_cost_limit: number
  hard_cost_limit: number
  estimated_cost_preflight: number
  budget_precheck_status: 'pending' | 'passed' | 'blocked'
  budget_precheck_reason: string
}

const MVP_POLICIES: Record<MvpCostJobType, MvpJobCostPolicy> = {
  analyze: {
    cost_estimate: 0.01,
    cost_accumulated: 0,
    soft_cost_limit: 0.05,
    hard_cost_limit: 0.1,
    estimated_cost_preflight: 0.01,
    budget_precheck_status: 'passed',
    budget_precheck_reason: 'MVP_STATIC_POLICY',
  },
  build_identity: {
    cost_estimate: 0.03,
    cost_accumulated: 0,
    soft_cost_limit: 0.1,
    hard_cost_limit: 0.2,
    estimated_cost_preflight: 0.03,
    budget_precheck_status: 'passed',
    budget_precheck_reason: 'MVP_STATIC_POLICY',
  },
  preview: {
    cost_estimate: 0.05,
    cost_accumulated: 0,
    soft_cost_limit: 0.2,
    hard_cost_limit: 0.4,
    estimated_cost_preflight: 0.05,
    budget_precheck_status: 'passed',
    budget_precheck_reason: 'MVP_STATIC_POLICY',
  },
}

export function getMvpJobCostPolicy(jobType: string): MvpJobCostPolicy {
  if (jobType === 'analyze' || jobType === 'build_identity' || jobType === 'preview') {
    return MVP_POLICIES[jobType]
  }
  throw new Error('UNSUPPORTED_COST_POLICY_JOB_TYPE')
}
