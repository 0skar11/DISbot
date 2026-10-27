// Conservative launch prices relative to the existing 50,000 CC palace. Configurable after
// observing real usage; no member balances are inspected or modified to choose these defaults.
export const COMPANY = Object.freeze({
    createCost: 100_000,
    maxLevel: 5,
    cooldownMs: 24 * 60 * 60 * 1000,
    quoteMs: 5 * 60 * 1000,
    branchCosts: [150_000, 300_000, 600_000, 1_200_000],
    qualityCosts: [40_000, 80_000, 160_000, 320_000],
    marketingCosts: [30_000, 60_000, 120_000, 240_000],
    maxDailyProfit: 6_000,
});
export const COMPANY_DAY_MS = 24 * 60 * 60 * 1000;
export const COMPANY_UPGRADES = Object.freeze({ branches: 'الفروع', quality: 'الجودة', marketing: 'التسويق' });

export function companyDaily(company) {
    // Demand is constrained by available branches. Marketing above that limit is useful only
    // after expansion, while quality improves the margin on each sale.
    const demand = Math.min(company.marketing, company.branches);
    const revenue = company.branches * (700 + 100 * company.quality + 120 * demand);
    const expenses = company.branches * (400 + 50 * company.quality + 70 * demand);
    return { revenue, expenses, profit: Math.min(COMPANY.maxDailyProfit, revenue - expenses) };
}

export function companyUpgradeCost(company, kind) {
    const prices = { branches: COMPANY.branchCosts, quality: COMPANY.qualityCosts, marketing: COMPANY.marketingCosts };
    return prices[kind]?.[company[kind] - 1] ?? null;
}
